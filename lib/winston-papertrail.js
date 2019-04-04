/*
 * winston-papertrail.js:
 *
 *          Transport for logging to Papertrail Service
 *          www.papertrailapp.com
 *
 * (C) 2013 Ken Perkins
 * MIT LICENCE
 *
 */

const os = require('os');
const net = require('net');
const tls = require('tls');
const glossy = require('glossy');
const Transport = require('winston-transport');

/**
 * Papertrail class
 *
 * @description constructor for the Papertrail transport
 *
 * @param {object}      options                 options for your papertrail transport
 * @param {string}      options.host            host for papertrail endpoint
 * @param {Number}      options.port            port for papertrail endpoint
 * @param {Boolean}     [options.disableTls]    disable TLS connections, enabled by default
 * @param {string}      [options.hostname]      name for the logging hostname in Papertrail
 * @param {string}      [options.program]       name for the logging program
 * @param {string}      [options.facility]      syslog facility for log messages
 * @param {string}      [options.level]         log level for your transport (info)
 * @param {string}      [options.levels]        custom mapping of log levels (npm levels to RFC5424 severities)
 * @param {Function}    [options.logFormat]     function to format your log message before sending
 * @param {Number}      [options.attemptsBeforeDecay]       how many reconnections should
 *                                                          be attempted before backing of (5)
 * @param {Number}      [options.maximumAttempts]           maximum attempts before
 *                                                          disabling buffering (25)
 * @param {Number}      [options.connectionDelay]           delay between
 *                                                          reconnection attempts in ms (1000)
 * @param {Boolean}     [options.handleExceptions]          passed to base Transport (false)
 * @param {Number}      [options.maxDelayBetweenReconnection]   when backing off,
 *                                                              what's the max time between
 *                                                              reconnections (ms)
 * @param {Boolean}     [options.flushOnClose]      send remaining messages before closing (false)
 */
module.exports = class Papertrail extends Transport {
  /**
   * constructor
   *
   * @param {object} options - The options
   * @return {void}
   **/
  constructor(options) {
    if (!options) {
      throw new Error('Missing options');
    }
    super(options);

    this._KEEPALIVE_INTERVAL = 15 * 1000;

    this.options = options;

    this.host = options.host;
    this.port = options.port;
    if (!this.host || !this.port) {
      throw new Error('Missing required parameters: host and port');
    }

    this.level = options.level || 'info';
    // Default npm log levels
    this.levels = options.levels || {
      silly: 7,
      debug: 7,
      verbose: 7,
      info: 6,
      warn: 4,
      error: 3,
    };

    this.disableTls = typeof options.disableTls === 'boolean' ? options.disableTls : false;
    this.hostname = options.hostname || os.hostname();
    this.program = options.program || 'default';
    this.facility = options.facility || 'daemon';
    this.logFormat = options.logFormat || function(level, message) {
      return level + ' ' + message;
    };

    this.attemptsBeforeDecay = options.attemptsBeforeDecay || 5;
    this.maximumAttempts = options.maximumAttempts || 25;
    this.connectionDelay = options.connectionDelay || 1000;
    this.handleExceptions = options.handleExceptions || false;
    this.maxDelayBetweenReconnection = options.maxDelayBetweenReconnection || 60000;
    this.maxBufferSize = options.maxBufferSize || 1 * 1024 * 1024;
    this.flushOnClose = options.flushOnClose || false;
    this.producer = new glossy.Produce({facility: this.facility});
    this.currentRetries = 0;
    this.totalRetries = 0;
    this.buffer = '';
    this.loggingEnabled = true;
    this._shutdown = false;

    this.connectStream();
  }

  /**
   * cleanup - cleanup
   *
   * @return {void}
   **/
  cleanup() {
    const self = this;
    self._erroring = true;
    try {
      if (self.socket) {
        self.socket.destroy();

        // this throws some uncatchable thing, eww.
        // self.socket.end();
        self.socket = null;
      }
    } catch (e) { }

    try {
      if (self.stream) {
        // we're cleaning up, don't loop.
        self.stream.removeListener('end', connectStream);
        self.stream.removeListener('error', onErrored);

        self.stream.destroy();
        self.stream = null;
      }
    } catch (e) { }
    self._erroring = false;
  }

  /**
   * write Streams
   *
   * @return {void}
   **/
  wireStreams() {
    const self = this;
    self.stream.once('error', this.onErrored);

    // If we have the stream end, simply reconnect
    self.stream.once('end', this.connectStream);
  }

  /**
   * Opens a connection to Papertrail
   *
   * @return {void}
   **/
  connectStream() {
    const self = this;
    // don't connect on either error or shutdown
    if (self._shutdown || self._erroring) {
      return;
    }

    this.cleanup();

    /**
     * onConnected callback
     *
     * @return {void}
     **/
    function onConnected() {
      // Reset our variables
      self.loggingEnabled = true;
      self.currentRetries = 0;
      self.totalRetries = 0;
      self.connectionDelay = self.options.connectionDelay || 1000;

      self.emit('connect', 'Connected to Papertrail at ' + self.host + ':' + self.port);
      self.processBuffer();
    }

    try {
      if (self.disableTls) {
        self.stream = net.createConnection(self.port, self.host, onConnected);
        self.stream.setKeepAlive(true, self._KEEPALIVE_INTERVAL);

        this.wireStreams();
      } else {
        const socket = net.createConnection(self.port, self.host, function() {
          socket.setKeepAlive(true, self._KEEPALIVE_INTERVAL);
          self.stream = tls.connect({
            socket: socket,
            rejectUnauthorized: false,
          }, onConnected);
          self.wireStreams();
        });

        socket.on('error', this.onErrored);
        self.socket = socket;
      }
    } catch (e) {
      this.onErrored(e);
    }
  }

  /**
   * _reconnvectStream
   *
   * @return {object} - Return value of connectStream
   **/
  _reconnectStream() {
    return this.connectStream();
  }

  /**
   * onErrored
   *
   * @param {object} err - The error object
   * @return {void}
   **/
  onErrored(err) {
    const self = this;
    // make sure we prevent simultaneous attempts to connect and handle errors
    self._erroring = true;

    self._silentErrorEmitter(err);

    // We may be disconnected from the papertrail endpoint for any number of reasons;
    // i.e. inactivity, network problems, etc, and we need to be resilient against this
    // that said, we back off reconnection attempts in case Papertrail is truly down
    setTimeout(function() {
      // Increment our retry counts
      self.currentRetries++;
      self.totalRetries++;

      // Decay the retry rate exponentially up to max between attempts
      if ((self.connectionDelay < self.maxDelayBetweenReconnection) &&
          (self.currentRetries >= self.attemptsBeforeDecay)) {
        self.connectionDelay = self.connectionDelay * 2;
        self.currentRetries = 0;
      }

      // Stop buffering messages after a fixed number of retries.
      // This is to keep the buffer from growing unbounded
      if (self.loggingEnabled && (self.totalRetries >= (self.maximumAttempts))) {
        self.loggingEnabled = false;
        self._silentErrorEmitter(new Error('Max entries eclipsed, disabling buffering'));
      }

      // continue
      self._erroring = false;
      connectStream();
    }, self.connectionDelay);
  }

  /**
 * Papertrail.log
 *
 * @description Core logging method exposed to Winston. Metadata is optional.
 *
 * @param {object} info - log info
 * @param {function} callback - callback function
 * @return {void}
 */
  log(info, callback) {
    if (!this.loggingEnabled) {
      return callback(null, true);
    }

    this.sendMessage(this.hostname, this.program, info.level, info.message, callback);
  };

  /**
 * Papertrail.sendMessage
 *
 * @description sending the message to the stream, or buffering if not connected
 *
 * @param {String}    hostname    Hostname of the source application.
 * @param {String}    program     Name of the source application
 * @param {String}    level        Log level of the message
 * @param {String}    message        The message to deliver
 * @param {Function}  callback      callback to be executed when the log has been written to the stream
 */
  sendMessage(hostname, program, level, message, callback) {
    const self = this;
    let lines = [];
    let msg = '';
    let gap = '';

    // Only split if we actually have a message
    if (message) {
      lines = message.split('\n');
    } else {
      lines = [''];
    }

    // If the incoming message has multiple lines, break them and format each
    // line as its own message
    for (let i = 0; i < lines.length; i++) {
      // don't send extra message if our message ends with a newline
      if ((lines[i].length === 0) && (i === lines.length - 1)) {
        break;
      }

      if (i === 1) {
        gap = '    ';
      }

      msg += self.producer.produce({
        severity: self.levels[level] ? self.levels[level] : level,
        host: hostname,
        appName: program,
        date: new Date(),
        message: self.logFormat(level, gap + lines[i]),
      }) + '\r\n';
    }

    if (this.stream && this.stream.writable) {
      this.processBuffer();
      this.stream.write(msg, callback);
    } else if (this.loggingEnabled && this.buffer.length < this.maxBufferSize) {
      this.buffer += msg;
    }
  };

  /**
 * If we have anything buffered, try to write it to the stream if we can before we log new messages
 */
  processBuffer() {
    const self = this;

    // Did we have buffered messages?
    if (this.buffer.length <= 0) {
      return;
    }

    // Is the stream writable?
    if (!this.stream || !this.stream.writable) {
      return;
    }

    this.stream.write(this.buffer, function() {
      if (!self.buffer.length) {
        self.stream.emit('empty');
      }
    });
    this.buffer = '';
  };

  /**
 * Papertrail.close
 *
 * @description closes the underlying TLS connection and disables automatic
 * reconnection, allowing the process to exit
 */
  close() {
    const self = this;

    self._shutdown = true;

    if (self.stream) {
      if (self.flushOnClose && self.buffer.length) {
        self.stream.on('empty', function() {
          // TODO: some kind of guard here to avoid infinite recursion?
          self.close();
        });
      } else {
        self.stream.end();
      }
    } else {
      // if there's no stream yet, that means we're still connecting
      // lets wire a connect handler, and then invoke close again
      self.on('connect', function() {
        self.close();
      });
    }
  };

  /**
 * The goal here is to ignore connection errors by default without triggering an uncaughtException.
 * You can still bind your own error handler as normal, but if you haven't overridden it, connection errors
 * will be logged to the console by default.
 *
 * Notes: This is meant to fix usability issues #20, and #49
 *
 * @param {object} err - error object
 * @private
 */
  _silentErrorEmitter(err) {
    const count = this.listeners('error').length;
    if (count > 0) {
      // the goal here is to ensure someone is catching this event, instead of potentially
      // causing the process to exit.
      this.emit('error', err);
    } else {
      console.error('Papertrail connection error: ', err);
    }
  };
};
