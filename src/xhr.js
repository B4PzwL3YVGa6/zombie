// Implemenets XMLHttpRequest.
// See http://www.w3.org/TR/XMLHttpRequest/#the-abort()-method


const DOM = require('./dom');
const URL = require('url');


class XMLHttpRequest extends DOM.EventTarget {

  constructor(window) {
    this._window      = window;
    this._browser     = window.browser;
    // Pending request
    this._pending     = null;
    // Response headers
    this.readyState   = XMLHttpRequest.UNSENT;

    this.onreadystatechange = null;
    this.timeout      = 0;

    // XHR events need the first to dispatch, the second to propagate up to window
    this._ownerDocument = window.document;
  }


  // Aborts the request if it has already been sent.
  abort() {
    // Tell any pending request it has been aborted.
    const request = this._pending;
    if (this.readyState === XMLHttpRequest.UNSENT || (this.readyState === XMLHttpRequest.OPENED && !request.sent)) {
      this.readyState = XMLHttpRequest.UNSENT;
      return;
    }

    // Tell any pending request it has been aborted.
    request.aborted = true;
  }


  // Initializes a request.
  //
  // Calling this method an already active request (one for which open()or
  // openRequest()has already been called) is the equivalent of calling abort().
  open(method, url, useAsync, user, password) { // jshint ignore:line
    if (useAsync === false)
      throw new DOM.DOMException(DOM.NOT_SUPPORTED_ERR, 'Zombie does not support synchronous XHR requests');

    // Abort any pending request.
    this.abort();

    // Check supported HTTP method
    method = method.toUpperCase();
    if (/^(CONNECT|TRACE|TRACK)$/.test(method))
      throw new DOM.DOMException(DOM.SECURITY_ERR, 'Unsupported HTTP method');
    if (!/^(DELETE|GET|HEAD|OPTIONS|POST|PUT)$/.test(method))
      throw new DOM.DOMException(DOM.SYNTAX_ERR, 'Unsupported HTTP method');

    const headers = {};

    // Normalize the URL and check security
    url = URL.parse(URL.resolve(this._window.location.href, url));
    // Don't consider port if they are standard for http and https
    if ((url.protocol === 'https:' && url.port === '443') ||
        (url.protocol === 'http:'  && url.port === '80'))
      delete url.port;

    if (!/^https?:$/i.test(url.protocol))
      throw new DOM.DOMException(DOM.NOT_SUPPORTED_ERR, 'Only HTTP/S protocol supported');
    url.hostname = url.hostname || this._window.location.hostname;
    url.host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
    if (url.host !== this._window.location.host) {
      headers.origin = `${this._window.location.protocol}//${this._window.location.host}`;
      this._cors = headers.origin;
    }
    url.hash = null;
    if (user)
      url.auth = `${user}:${password}`;
    // Used for logging requests
    this._url       = URL.format(url);

    // Reset response status
    this._response  = null;
    this._error     = null;

    const request   = { method, headers, url: URL.format(url) };
    this._pending   = request;
    this._stateChanged(XMLHttpRequest.OPENED);
  }


  // Sets the value of an HTTP request header.You must call setRequestHeader()
  // after open(), but before send().
  setRequestHeader(header, value) {
    if (this.readyState !== XMLHttpRequest.OPENED)
      throw new DOM.DOMException(DOM.INVALID_STATE_ERR,  'Invalid state');
    const request = this._pending;
    request.headers[header.toString().toLowerCase()] = value.toString();
  }


  // Sends the request. If the request is asynchronous (which is the default),
  // this method returns as soon as the request is sent. If the request is
  // synchronous, this method doesn't return until the response has arrived.
  send(data) {
    // Request must be opened.
    if (this.readyState !== XMLHttpRequest.OPENED)
      throw new DOM.DOMException(DOM.INVALID_STATE_ERR,  'Invalid state');

    const request = this._pending;
    this._fire('loadstart');

    request.headers['content-type'] = request.headers['content-type'] || 'text/plain';
    // Make the actual request
    request.body    = data;
    request.timeout = this.timeout;

    this._window._eventQueue.http(request.method, request.url, request, (error, response)=> {
      if (this._pending === request)
        this._pending = null;

      // Request aborted
      if (request.aborted) {
        this._stateChanged(XMLHttpRequest.DONE);
        this._fire('progress');
        this._error = new DOM.DOMException(DOM.ABORT_ERR, 'Request aborted');
        this._fire('abort', this._error);
        return;
      }

      if (error) {
        this._stateChanged(XMLHttpRequest.DONE);
        this._fire('progress');
        if (error.code === 'ETIMEDOUT') {
          this._error = new DOM.DOMException(DOM.TIMEOUT_ERR, 'The request timed out');
          this._fire('timeout', this._error);
        } else {
          this._error = new DOM.DOMException(DOM.NETWORK_ERR, error.message);
          this._fire('error', this._error);
        }
        this._fire('loadend');
        this._browser.errors.push(this._error);
        return;
      }

      // CORS request, check origin, may lead to new error
      if (this._cors) {
        const allowedOrigin = response.headers['access-control-allow-origin'];
        if (!(allowedOrigin === '*' || allowedOrigin === this._cors)) {
          this._error = new DOM.DOMException(DOM.SECURITY_ERR, 'Cannot make request to different domain');
          this._browser.errors.push(this._error);
          this._stateChanged(XMLHttpRequest.DONE);
          this._fire('progress');
          this._fire('error', this._error);
          this._fire('loadend');
          this.raise('error', this._error.message, { exception: this._error });
          return;
        }
      }

      // Store the response so getters have acess access it
      this._response        = response;
      // We have a one-stop implementation that goes through all the state
      // transitions
      this._stateChanged(XMLHttpRequest.HEADERS_RECEIVED);
      this._stateChanged(XMLHttpRequest.LOADING);
      this._stateChanged(XMLHttpRequest.DONE);

      this._fire('progress');
      this._fire('load');
      this._fire('loadend');

    });
    request.sent = true;
  }


  get status() {
    // Status code/headers available immediatly, 0 if request errored
    return this._response ? this._response.statusCode :
           this._error    ? 0 : null;
  }

  get statusText() {
    // Status code/headers available immediatly, '' if request errored
    return this._response ? this._response.statusText :
           this._error    ? '' : null;
  }

  get responseText() {
    // Response body available only after LOADING event, check for response
    // since DONE event triggered in all cases
    const hasBody = (this._response && this.readyState >= XMLHttpRequest.LOADING);
    if (hasBody) {
      const body = this._response.body;
      return Buffer.isBuffer(body) ? body.toString() : body;
    } else
      return null;
  }

  get responseXML() {
    // Not implemented yet
    return null;
  }

  getResponseHeader(name) {
    // Returns the string containing the text of the specified header, or null if
    // either the response has not yet been received or the header doesn't exist in
    // the response.
    return this._response && this._response.headers[name.toLowerCase()] || null;
  }

  getAllResponseHeaders() {
    // Returns all the response headers as a string, or null if no response has
    // been received. Note: For multipart requests, this returns the headers from
    // the current part of the request, not from the original channel.
    if (this._response)
      // XHR's getAllResponseHeaders, against all reason, returns a multi-line
      // string.  See http://www.w3.org/TR/XMLHttpRequest/#the-getallresponseheaders-method
      return Object.keys(this._response.headers)
        .map(name => [name.toLowerCase(), this._response.headers[name]] )
        .map(pair => pair.join(': ') )
        .join('\n');
    else
      return null;
  }


  // Fire onreadystatechange event
  _stateChanged(newState) {
    this.readyState = newState;
    this._fire('readystatechange');
  }

  // Fire the named event on this object
  _fire(eventName, error) {
    const event = new DOM.Event('xhr');
    event.initEvent(eventName, true, true);
    event.error = error;
    this.dispatchEvent(event);
    this._browser.emit('xhr', eventName, this._url);
  }

  // Raise error coming from jsdom
  raise(type, message, data) {
    this._ownerDocument.raise(type, message, data);
  }

}


// Lifecycle states
XMLHttpRequest.UNSENT           = 0;
XMLHttpRequest.OPENED           = 1;
XMLHttpRequest.HEADERS_RECEIVED = 2;
XMLHttpRequest.LOADING          = 3;
XMLHttpRequest.DONE             = 4;

module.exports = XMLHttpRequest;

