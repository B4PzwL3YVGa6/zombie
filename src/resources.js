// Retrieve resources (HTML pages, scripts, XHR, etc).
//
// If count is unspecified, defaults to at least one.
//
// Each browser has a resources objects that allows you to:
// - Inspect the history of retrieved resources, useful for troubleshooting
//   issues related to resource loading
// - Request resources directly, but have Zombie handle cookies,
//   authentication, etc
// - Implement new mechanism for retrieving resources, for example, add new
//   protocols or support new headers


const _           = require('lodash');
const assert      = require('assert');
const Bluebird    = require('bluebird');
const DOM         = require('./dom');
const File        = require('fs');
const { Headers } = require('./fetch');
const HTTP        = require('http');
const iconv       = require('iconv-lite');
const { isArray } = require('util');
const Path        = require('path');
const QS          = require('querystring');
const Request     = require('request');
const URL         = require('url');
const Utils       = require('jsdom/lib/jsdom/utils');
const Zlib        = require('zlib');




/*
class Request {

  constructor(input, init) {
    if (input instanceof Request) {
      this.url      = input.url;
      this.method   = input.method;
      this.headers  = input.headers.clone();

    } else if (typeof input === 'string' || input instanceof String) {
      this.url      = URL.parse(input);
    }

    if (init.body != null) {
      if ()
    }
  }

}
*/



// Called to execute the next response handler.
function nextResponseHandler(browser, req, res, handlers, callback) {
  const handler = handlers[0];
  if (handler)

    // Use the next response handler
    try {
      handler.call(browser, req, res, function(error, newResponse = res) {
        if (error)
          callback(error);
        else
          nextResponseHandler(browser, req, newResponse, handlers.slice(1), callback);
      });
    } catch (error) {
      callback(error);
    }

  else
    // Out of handlers, pass response back to request maker
    callback(null, res);
}

// Called to execute the next request handler, when we have a request, pass
// control to nextResponseHandler, and eventuall callback.
function nextRequestHandler(browser, req, handlers, callback) {
  const handler = handlers[0];
  assert(handler && handler.length === 2, 'Expected 2 arguments request handler');
  try {
    handler.call(browser, req, function(error, res) {
      if (error)
        callback(error);
      else if (res) {
        // If we get redirected and the final handler doesn't provide a
        // URL (e.g.  mock response), then without this we end up with the
        // original URL.
        res.url = res.url || req.url;
        // Once we have a response, we switch to response processing,
        // otherwise we fall through and try to make HTTP request
        const responseHandlers = handlers.filter(fn => fn.length === 3);
        nextResponseHandler(browser, req, res, responseHandlers, callback);
      } else
        nextRequestHandler(browser, req, handlers.slice(1), callback);
    });
  } catch (error) {
    callback(error);
  }
}


function formData(name, value) {
  if (value.read) {
    const buffer = value.read();
    return {
      'Content-Disposition':  `form-data; name=\"${name}\"; filename=\"${value}\"`,
      'Content-Type':         value.mime || 'application/octet-stream',
      'Content-Length':       buffer.length,
      body:                   buffer
    };
  } else
    return {
      'Content-Disposition':  `form-data; name=\"${name}\"`,
      'Content-Type':         'text/plain; charset=utf8',
      'Content-Length':       value.length,
      body:                   value
    };
}


// Find the charset= value of the meta tag
const MATCH_CHARSET = /<meta(?!\s*(?:name|value)\s*=)[^>]*?charset\s*=[\s"']*([^\s"'\/>]*)/i;


class Resource {

  constructor({ request, target }) {
    this.request  = request;
    this.target   = target;
    this.error    = null;
    this.response = null;
  }

  get url() {
    return (this.response && this.response.url) || this.request.url;
  }

  dump(output) {
    const { request, response, error, target } = this;
    // Write summary request/response header
    if (response) {
      const elapsed = response.time - request.time;
      output.write(`${request.method} ${this.url} - ${response.statusCode} ${response.statusText} - ${elapsed}ms\n`);
    } else
      output.write(`${request.method} ${this.url}\n`);

    // Tell us which element/document is loading this.
    if (target instanceof DOM.Document)
      output.write('  Loaded as HTML document\n');
    else if (target && target.id)
      output.write(`  Loading by element #${target.id}\n`);
    else if (target)
      output.write(`  Loading as ${target.tagName} element\n`);

    // If response, write out response headers and sample of document entity
    // If error, write out the error message
    // Otherwise, indicate this is a pending request
    if (response) {
      if (response.redirects)
        output.write(`  Followed ${response.redirects} redirects\n`);
      for (let [name, value] of response.headers)
        output.write(`  ${name}: ${value}\n`);
      output.write('\n');
      const sample = response.body
        .slice(0, 250)
        .toString('utf8')
        .split('\n')
        .map(line => `  ${line}`)
        .join('\n');
      output.write(sample);
    } else if (error)
      output.write(`  Error: ${error.message}\n`);
    else
      output.write(`  Pending since ${new Date(request.time)}\n`);
    // Keep them separated
    output.write('\n\n');
  }

}




// Each browser has a resources object that provides the means for retrieving
// resources and a list of all retrieved resources.
//
// The object is an array, and its elements are the resources.
class Resources extends Array {

  constructor(browser) {
    this.browser  = browser;
    this.pipeline = Resources.pipeline.slice();
  }


  // Make an HTTP request (also supports file: protocol).
  //
  // method    - Request method (GET, POST, etc)
  // url       - Request URL
  // options   - See below
  // callback  - Called with error, or null and response
  //
  // Without callback, returns a promise.
  //
  // Options:
  //   headers   - Name/value pairs of headers to send in request
  //   params    - Parameters to pass in query string or document body
  //   body      - Request document body
  //   timeout   - Request timeout in milliseconds (0 or null for no timeout)
  //
  // Response contains:
  //   url         - Actual resource URL (changed by redirects)
  //   statusCode  - Status code
  //   statusText  - HTTP status text ("OK", "Not Found" etc)
  //   headers     - Response headers
  //   body        - Response body
  //   redirects   - Number of redirects followed
  request(method, url, options = {}, callback = null) {
    if (!callback && typeof options === 'function')
      [options, callback] = [{}, options];

    const req = {
      method:     method.toUpperCase(),
      url:        url,
      headers:    new Headers(options.headers),
      params:     options.params,
      body:       options.body,
      time:       Date.now(),
      timeout:    options.timeout || 0,
      strictSSL:  this.browser.strictSSL,
      localAddress: this.browser.localAddress || 0
    };

    const resource = new Resource({
      request:    req,
      target:     options.target
    });
    this.push(resource);
    this.browser.emit('request', req);

    const promise = new Bluebird((resolve, reject)=> {
      this._runPipeline(req, (error, res)=> {
        if (error) {
          resource.error = error;
          reject(error);
        } else {
          res.statusCode    = res.statusCode || 200;
          res.statusText    = HTTP.STATUS_CODES[res.statusCode] || 'Unknown';
          res.redirects     = res.redirects || 0;
          res.time          = Date.now();
          resource.response = res;

          this.browser.emit('response', req, res);
          resolve(resource.response);
        }
      });
    });

    if (callback)
      promise.done((res)=> callback(null, res), callback);
    else
      return promise;
  }


  // GET request.
  //
  // url       - Request URL
  // options   - See request() method
  // callback  - Called with error, or null and response
  get(url, options, callback) {
    return this.request('get', url, options, callback);
  }

  // POST request.
  //
  // url       - Request URL
  // options   - See request() method
  // callback  - Called with error, or null and response
  post(url, options, callback) {
    return this.request('post', url, options, callback);
  }


  // Human readable resource listing.
  //
  // output - Write to this stream (optional)
  dump(output = process.stdout) {
    if (this.length === 0)
      output.write('No resources\n');
    else
      this.forEach(resource => resource.dump(output));
  }

  // Add a request/response handler.  This handler will only be used by this
  // browser.
  addHandler(handler) {
    assert(handler.call, 'Handler must be a function');
    assert(handler.length === 2 || handler.length === 3, 'Handler function takes 2 (request handler) or 3 (reponse handler) arguments');
    this.pipeline.push(handler);
  }

  // Processes the request using the pipeline.
  _runPipeline(req, callback) {
    const { browser } = this;
    const requestHandlers   = this.pipeline.filter(fn => fn.length === 2);
    const responseHandlers  = this.pipeline.filter(fn => fn.length === 3);
    // Request handlers -> make HTTP request -> Response handlers
    const handlersInOrder   = requestHandlers.concat(Resources.makeHTTPRequest).concat(responseHandlers);

    // Start with first request handler
    nextRequestHandler(browser, req, handlersInOrder, callback);
  }


  // -- Handlers --

  static addHandler(handler) {
    assert(handler.call, 'Handler must be a function');
    assert(handler.length === 2 || handler.length === 3, 'Handler function takes 2 (request handler) or 3 (response handler) arguments');
    this.pipeline.push(handler);
  }


  // This handler normalizes the request URL.
  //
  // It turns relative URLs into absolute URLs based on the current document URL
  // or base element, or if no document open, based on browser.site property.
  //
  // Also creates query string from request.params for
  // GET/HEAD/DELETE requests.
  static normalizeURL(req, next) {
    const browser = this;
    if (browser.document)
    // Resolve URL relative to document URL/base, or for new browser, using
    // Browser.site
      req.url = DOM.resourceLoader.resolve(browser.document, req.url);
    else
      req.url = Utils.resolveHref(browser.site || 'http://localhost', req.url);

    if (req.params) {
      const { method } = req;
      if (method === 'GET' || method === 'HEAD' || method === 'DELETE') {
        // These methods use query string parameters instead
        const uri = URL.parse(req.url, true);
        Object.assign(uri.query, req.params);
        req.url = URL.format(uri);
      }
    }

    next();
  }


  // This handler mergers request headers.
  //
  // It combines headers provided in the request with custom headers defined by
  // the browser (user agent, authentication, etc).
  //
  // It also normalizes all headers by down-casing the header names.
  static mergeHeaders(req, next) {
    const browser = this;
    if (browser.headers)
      _.each(browser.headers, (value, name)=> {
        req.headers.append(name, browser.headers[name]);
      });
    if (!req.headers.has('User-Agent'))
      req.headers.set('User-Agent', browser.userAgent);

    // Always pass Host: from request URL
    const { host } = URL.parse(req.url);
    req.headers.set('Host', host);

    // HTTP Basic authentication
    const authenticate = { host, username: null, password: null };
    browser.emit('authenticate', authenticate);
    const { username, password } = authenticate;
    if (username && password) {
      browser.log(`Authenticating as ${username}:${password}`);
      const base64 = new Buffer(`${username}:${password}`).toString('base64');
      req.headers.set('authorization',  `Basic ${base64}`);
    }

    next();
  }


  // Depending on the content type, this handler will create a request body from
  // request.params, set request.multipart for uploads.
  static createBody(req, next) {
    const { method } = req;
    if (method !== 'POST' && method !== 'PUT') {
      next();
      return;
    }

    const { headers } = req;
    // These methods support document body.  Create body or multipart.
    headers.set('content-type', headers.get('content-type') || 'application/x-www-form-urlencoded');
    const mimeType = headers.get('content-type').split(';')[0];
    if (req.body) {
      next();
      return;
    }

    const params = req.params || {};
    switch (mimeType) {
      case 'application/x-www-form-urlencoded': {
        req.body = QS.stringify(params);
        headers.set('content-length', req.body.length);
        next();
        break;
      }

      case 'multipart/form-data': {
        if (Object.keys(params).length === 0) {
          // Empty parameters, can't use multipart
          headers.set('content-type', 'text/plain');
          req.body = '';
        } else {

          const boundary = `${new Date().getTime()}.${Math.random()}`;
          const withBoundary = headers.get('content-type') + `; boundary=${boundary}`;
          headers.set('content-type', withBoundary);
          req.multipart = Object.keys(params)
            .reduce((parts, name)=> {
              const values = params[name]
                .map(value => formData(name, value) );
              return parts.concat(values);
            }, []);
        }
        next();
        break;
      }

      case 'text/plain': {
        // XHR requests use this by default
        next();
        break;
      }

      default: {
        next(new Error(`Unsupported content type ${mimeType}`));
        break;
      }
    }
  }


  // Used to perform HTTP request (also supports file: resources).  This is always
  // the last request handler.
  static makeHTTPRequest(req, next) {
    const browser = this;
    const { protocol, hostname, pathname } = URL.parse(req.url);
    if (protocol === 'file:') {

      // If the request is for a file:// descriptor, just open directly from the
      // file system rather than getting node's http (which handles file://
      // poorly) involved.
      if (req.method !== 'GET') {
        next(null, { statusCode: 405 });
        return;
      }

      const filename = Path.normalize(decodeURI(pathname));
      File.exists(filename, function(exists) {
        if (exists)
          File.readFile(filename, function(error, buffer) {
            // Fallback with error -> callback
            if (error) {
              req.error = error;
              next(error);
            } else
              next(null, { body: buffer });
          });
        else
          next(null, { statusCode: 404 });
      });

    } else {

      // We're going to use cookies later when recieving response.
      const { cookies } = browser;
      req.headers.append('Cookie', cookies.serialize(hostname, pathname));

      const request = new Request({
        method:         req.method,
        uri:            req.url,
        headers:        req.headers.toObject(),
        body:           req.body,
        multipart:      req.multipart,
        proxy:          browser.proxy,
        jar:            false,
        followRedirect: false,
        encoding:       null,
        strictSSL:      req.strictSSL,
        localAddress:   req.localAddress || 0,
        timeout:        req.timeout || 0
      });
      const buffers = [];
      request.on('data', (buffer)=> {
        buffers.push(buffer);
      });
      request.on('complete', (response)=> {

        // Request returns an object where property name is header name,
        // property value is either header value, or an array if header sent
        // multiple times (e.g. `Set-Cookie`).
        const arrayOfHeaders = _.reduce(response.headers, (headers, value, name)=> {
          if (isArray(value))
            for (let item of value)
              headers.push([name, item]);
          else
            headers.push([name, value]);
          return headers;
        }, []);

        next(null, {
          url:          req.url,
          statusCode:   response.statusCode,
          headers:      new Headers(arrayOfHeaders),
          body:         Buffer.concat(buffers),
          redirects:    response.redirects || 0
        });
      });
      request.on('error', next);
    }

  }


  static handleResponse(req, res, next) {
    const browser = this;
    res.headers = new Headers(res.headers);

    const { protocol, hostname, pathname } = URL.parse(req.url);
    if (protocol !== 'http:' && protocol !== 'https:') {
      next();
      return;
    }

    // Set cookies from response: call update() with array of headers
    const newCookies = res.headers.getAll('Set-Cookie');
    browser.cookies.update(newCookies, hostname, pathname);

    // Number of redirects so far.
    let redirects   = req.redirects || 0;
    let redirectUrl = null;

    // Determine whether to automatically redirect and which method to use
    // based on the status code
    const { statusCode } = res;
    if ((statusCode === 301 || statusCode === 307) &&
        (req.method === 'GET' || req.method === 'HEAD'))
      // Do not follow POST redirects automatically, only GET/HEAD
      redirectUrl = Utils.resolveHref(req.url, res.headers.get('Location') || '');
    else if (statusCode === 302 || statusCode === 303)
      // Follow redirect using GET (e.g. after form submission)
      redirectUrl = Utils.resolveHref(req.url, res.headers.get('Location') || '');

    if (redirectUrl) {

      res.url = redirectUrl;
      // Handle redirection, make sure we're not caught in an infinite loop
      ++redirects;
      if (redirects > browser.maxRedirects) {
        next(new Error(`More than ${browser.maxRedirects} redirects, giving up`));
        return;
      }

      const redirectHeaders = new Headers(req.headers);
      // This request is referer for next
      redirectHeaders.set('Referer', req.url);
      // These headers exist in POST request, do not pass to redirect (GET)
      redirectHeaders.delete('Content-Type');
      redirectHeaders.delete('Content-Length');
      redirectHeaders.delete('Content-Transfer-Encoding');
      // Redirect must follow the entire chain of handlers.
      const redirectRequest = {
        method:     'GET',
        url:        res.url,
        headers:    redirectHeaders,
        redirects:  redirects,
        strictSSL:  req.strictSSL,
        time:       req.time,
        timeout:    req.timeout
      };
      browser.emit('redirect', req, res, redirectRequest);
      browser.resources._runPipeline(redirectRequest, next);

    } else {
      res.redirects = redirects;
      next();
    }
  }


  // Handle deflate and gzip transfer encoding.
  static decompressBody(req, res, next) {
    const transferEncoding  = res.headers.get('Transfer-Encoding');
    const contentEncoding   = res.headers.get('Content-Encoding');
    if (contentEncoding === 'deflate' || transferEncoding === 'deflate')
      Zlib.inflate(res.body, (error, buffer)=> {
        res.body = buffer;
        next(error);
      });
    else if (contentEncoding === 'gzip' || transferEncoding === 'gzip')
      Zlib.gunzip(res.body, (error, buffer)=> {
        res.body = buffer;
        next(error);
      });
    else
      next();
  }


  // This handler decodes the response body based on the response content type.
  static decodeBody(req, res, next) {
    if (!Buffer.isBuffer(res.body)) {
      next();
      return;
    }

    // If Content-Type header specifies charset, use that
    const contentType = res.headers.get('Content-Type') || 'application/unknown';
    const [mimeType, ...typeOptions]  = contentType.split(/;\s*/);
    const [type, subtype]             = contentType.split(/\//, 2);

    // Images, binary, etc keep response body a buffer
    if (type && type !== 'text') {
      next();
      return;
    }

    let charset = null;

    // Pick charset from content type
    if (mimeType)
      for (let typeOption of typeOptions) {
        if (/^charset=/i.test(typeOption)) {
          charset = typeOption.split('=')[1];
          break;
        }
      }

    // Otherwise, HTML documents only, pick charset from meta tag
    // Otherwise, HTML documents only, default charset in US is windows-1252
    const isHTML = /html/.test(subtype) || /\bhtml\b/.test(req.headers.get('Accept'));
    if (!charset && isHTML) {
      const match = res.body.toString().match(MATCH_CHARSET);
      charset = match ? match[1] : 'windows-1252';
    }

    if (charset)
      res.body = iconv.decode(res.body, charset);
    next();
  }


}

// All browsers start out with this list of handler.
Resources.pipeline = [
  Resources.normalizeURL,
  Resources.mergeHeaders,
  Resources.createBody,
  Resources.handleResponse,
  Resources.decompressBody,
  Resources.decodeBody
];


module.exports = Resources;

