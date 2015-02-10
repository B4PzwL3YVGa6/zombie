JSDOM_PATH  = require.resolve("jsdom")
DOM         = require("#{JSDOM_PATH}/../jsdom/living")


# Additional error codes defines for XHR and not in JSDOM.
DOM.SECURITY_ERR  = 18
DOM.NETWORK_ERR   = 19
DOM.ABORT_ERR     = 20
DOM.TIMEOUT_ERR   = 23


module.exports = DOM
