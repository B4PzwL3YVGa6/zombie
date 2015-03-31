const _       = require('lodash');
const HTTP    = require('http');
const Promise = require('bluebird');
const Stream  = require('stream');
const URL     = require('url');
const Zlib    = require('zlib');


// Decompress stream based on content and transfer encoding headers.
function decompressStream(stream, headers) {
  const transferEncoding  = headers.get('Transfer-Encoding');
  const contentEncoding   = headers.get('Content-Encoding');
  if (contentEncoding === 'deflate' || transferEncoding === 'deflate')
    return stream.pipe( Zlib.createInflate() );
  if (contentEncoding === 'gzip' || transferEncoding === 'gzip')
    return stream.pipe( Zlib.createGunzip() );
  return stream;
}


// https://fetch.spec.whatwg.org/#headers-class
class Headers {

  constructor(init) {
    this._headers = [];
    if (init instanceof Headers)
      for (let [name, value] of init)
        this.append(name, value);
    else if (init instanceof Array)
      for (let [name, value] of init)
        this.append(name, value);
    else if (init instanceof Object)
      _.each(init, (value, name)=> {
        this.append(name, value);
      });
  }

  append(name, value) {
    const caseInsensitive = name.toLowerCase();
    const castValue       = String(value).replace(/\r\n/g, '');
    this._headers.push([caseInsensitive, castValue]);
  }

  delete(name) {
    const caseInsensitive = name.toLowerCase();
    this._headers = this._headers.filter(header => header[0] !== caseInsensitive);
  }

  get(name) {
    const caseInsensitive = name.toLowerCase();
    const header = _.find(this._headers, header => header[0] === caseInsensitive);
    return header ? header[1] : null;
  }

  getAll(name) {
    const caseInsensitive = name.toLowerCase();
    return this._headers
      .filter(header => header[0] === caseInsensitive)
      .map(header => header[1]);
  }

  has(name) {
    const caseInsensitive = name.toLowerCase();
    const header = _.find(this._headers, header => header[0] === caseInsensitive);
    return !!header;
  }

  set(name, value) {
    const caseInsensitive = name.toLowerCase();
    const castValue       = String(value).replace(/\r\n/g, '');
    let   replaced        = false;
    this._headers = this._headers.reduce((headers, [name, value])=> {
      if (name !== caseInsensitive)
        headers.push([name, value]);
      else if (!replaced) {
        headers.push([name, castValue]);
        replaced = true;
      }
      return headers;
    }, []);

    if (!replaced)
      this.append(name, value);
  }

  [Symbol.iterator]() {
    return this._headers[Symbol.iterator]();
  }

  valueOf() {
    return this._headers.map(([name, value])=> `${name}: ${value}`);
  }

  toString() {
    return this.valueOf().join('\n');
  }

  toObject() {
    const object = Object.create(null);
    for (let [name, value] of this._headers)
      object[name] = value;
    return object;
  }

}


class FormData {

  constructor() {
    this._entries = [];
  }

  append(name, value, filename) {
    // TODO add support for files
    this._entries.push([name, value]);
  }

  set(name, value, filename) {
    this.delete(name);
    this.append(name, value, filename);
  }

  delete(name) {
    this._entries = this._entries.filter(entry => entry[0] !== name);
  }

  get(name) {
    const entry = _.find(this._entries, entry => entry[0] === name);
    return entry ? entry[1] : null;
  }

  getAll(name) {
    return this._entries
      .filter(entry => entry[0] === name)
      .map(entry => entry[1]);
  }

  has(name) {
    const entry = _.find(this._entries, entry => entry[0] === name);
    return !!entry;
  }

  [Symbol.iterator]() {
    return this._entries[Symbol.iterator]();
  }

  get length() {
    return this._entries.length;
  }

  _asStream(boundary) {
    const iterator  = this._entries[Symbol.iterator]();
    const stream    = new Stream.Readable();
    stream._read = function() {
      const next = iterator.next();
      if (next.value) {
        const [name, value] = next.value;
        this.push(`--${boundary}\r\n`);
        if (value.read) {
          const buffer = value.read();
          this.push(`Content-Disposition: form-data; name=\"${name}\"; filename=\"${value}\"\r\n`);
          this.push(`Content-Type: ${value.mime || 'application/octet-stream'}\r\n`);
          this.push(`Content-Length: ${buffer.length}\r\n\r\n`);
          this.push(buffer);
        } else {
          const text = value.toString('utf-8');
          this.push(`Content-Disposition: form-data; name=\"${name}\"\r\n`);
          this.push(`Content-Type: text/plain; charset=utf8\r\n\r\n`);
          this.push(`Content-Length: ${text.length}\r\n\r\n`);
          this.push(text);
        }
        this.push('\r\n');
      }
      if (next.done) {
        this.push(`--${boundary}--`);
        this.push(null);
      }
    };
    return stream;
  }
}


class Body {

  constructor(bodyInit) {
    if (bodyInit instanceof Body) {
      this._stream = bodyInit._stream;
      this._setContentType(bodyInit.headers.get('Content-Type'));
    } else if (bodyInit instanceof Stream.Readable) {
      // Request + Replay start streaming immediately, so we need this trick to
      // buffer HTTP responses; this is likely a bug in Replay
      this._stream = new Stream.PassThrough();
      this._stream.pause();
      bodyInit.pipe(this._stream);
    } else if (typeof bodyInit === 'string' || bodyInit instanceof String) {
      this._stream = new Stream.Readable();
      this._stream._read = function() {
        this.push(bodyInit);
        this.push(null);
      };
      this._setContentType('text/plain;charset=UTF-8');
    } else if (bodyInit instanceof FormData && bodyInit.length) {
      const boundary = `${new Date().getTime()}.${Math.random()}`;
      this._setContentType(`multipart/form-data;boundary=${boundary}`);
      this._stream   = bodyInit._asStream(boundary);
    } else if (bodyInit instanceof FormData)
      this._setContentType('text/plain;charset=UTF-8');
    else if (bodyInit)
      throw new TypeError('This body type not yet supported');

    this._bodyUsed  = false;
    this.body       = null;
  }

  _setContentType(contentType) {
    if (contentType && !this.headers.has('Content-Type'))
      this.headers.set('Content-Type', contentType);
  }

  get bodyUsed() {
    return this._bodyUsed;
  }

  async arrayBuffer() {
    this.body         = await this._consume();
    const arrayBuffer = new Uint8Array(this.body.length);
    for (let i = 0; i < this.body.length; ++i)
      arrayBuffer[i] = this.body[i];
    return arrayBuffer;
  }

  async blob() {
    throw new Error('Not implemented yet');
  }

  async formData() {
    const buffer      = await this._consume();
    const contentType = this.headers.get('Content-Type') || '';
    const mimeType    = contentType.split(';')[0];
    switch (mimeType) {
      case 'multipart/form-data': {
        throw new Error('Not implemented yet');
      }
      case 'application/x-www-form-urlencoded': {
        throw new Error('Not implemented yet');
      }
      default: {
        throw new TypeError(`formData does not support MIME type ${mimeType}`);
      }
    }
  }

  async json() {
    const buffer  = await this._consume();
    this.body     = buffer.toString('utf-8');
    return JSON.parse(this.body);
  }

  async text() {
    const buffer      = await this._consume();
    this.body         = buffer.toString();
    return this.body;
  }


  // -- Implementation details --

  async _consume() {
    if (this._bodyUsed)
      throw new TypeError('Body already consumed');
    this._bodyUsed = true;

    // When Request has no body, _stream is typically null
    if (!this._stream)
      return null;
    // When Response has no body, we get stream that's no longer readable
    if (!this._stream.readable)
      return new Buffer('');

    const decompressed = decompressStream(this._stream, this.headers);

    return await new Promise((resolve)=> {
      const buffers = [];
      decompressed
        .on('data', (buffer)=> {
          buffers.push(buffer);
        })
        .on('end', ()=> {
          resolve(Buffer.concat(buffers));
        })
        .on('error', ()=> {
          resolve(Buffer.concat(buffers));
        })
        .resume();
    });
  }

}


// https://fetch.spec.whatwg.org/#request-class
class Request extends Body {

  constructor(input, init) {
    let bodyInit = null;

    if (input instanceof Request && input._stream) {
      if (input._bodyUsed)
        throw new TypeError('Request body already used');
      bodyInit        = input;
      input._bodyUsed = true;
    }

    if (typeof input === 'string' || input instanceof String)
      this.url = URL.format(input);
    else if (input instanceof Request)
      this.url = input.url;
    if (!this.url)
      throw new TypeError('Input must be string or another Request');

    this.method   = ((init ? init.method : input.method) || 'GET').toUpperCase();
    this.headers  = new Headers(init ? init.headers : input.headers);

    if (init && init.body) {
      if (this.method === 'GET' || this.method === 'HEAD')
        throw new TypeError('Cannot include body with GET/HEAD request');
      bodyInit = init.body;
    }

    // Default redirect is follow, also treat manual as follow
    this.redirect = init && init.redirect;
    if (this.redirect !== 'error')
      this.redirect = 'follow';
    this._redirectCount = 0;

    super(bodyInit);
  }

  // -- From Request interface --

  clone() {
    if (this._bodyUsed)
      throw new TypeError('This Request body has already been used');
    throw new Error('Not implemented yet');
  }


  // -- From Body interface --

}


// https://fetch.spec.whatwg.org/#response-class
class Response extends Body {

  constructor(bodyInit, responseInit) {
    if (responseInit) {
      if (responseInit.status < 200 || responseInit.status > 599)
        throw new RangeError(`Status code ${responseInit.status} not in range`);
      const statusText = responseInit.statusText || HTTP.STATUS_CODES[responseInit.status] || 'Unknown';
      if (!/^[^\n\r]+$/.test(statusText))
        throw new TypeError(`Status text ${responseInit.statusText} not valid format`);

      this._url       = URL.format(responseInit.url || '');
      this.type       = 'default';
      this.status     = responseInit.status;
      this.statusText = statusText;
      this.headers    = new Headers(responseInit.headers);
    } else {
      this.type       = 'error';
      this.status     = 0;
      this.statusText = '';
      this.headers    = new Headers();
    }

    super(bodyInit);
  }

  get url() {
    return (this._url || '').split('#')[0];
  }

  get ok() {
    return (this.status >= 200 && this.status <= 299);
  }

  clone() {
    if (this._bodyUsed)
      throw new TypeError('This Response body has already been used');
    throw new Error('Not implemented yet');
  }

  static error() {
    return new Response();
  }

  static redirect(url, status = 302) {
    const parsedURL = URL.parse(url);
    if ([301, 302, 303, 307, 308].indexOf(status) < 0)
      throw new RangeError(`Status code ${status} not valid redirect code`);
    const statusText = HTTP.STATUS_CODES[status];
    const response = new Response(null, { status, statusText });
    response.headers.set('Location', URL.format(parsedURL));
    return response;
  }
}


module.exports = {
  Headers,
  FormData,
  Request,
  Response
};
