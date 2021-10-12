(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
  var HttpError = require('./httperror');
  var PropertyUtil = require('./util/property');
  /**
   * @author jwitz
   * @version 1.0.1
   *
   * Handles POSTing requests to event-bridge and handling successes and failures
   * to emit as events or callback completion functions
   *
   * @constructor
   * @param {string} channelUrl - the event-bridge channel to post to
   * @param {string} eventEmitter - the handler of events and completion callbacks
   * @param {int} maxRetries - Number of retries to invoke if an HTTP request fails.
   * @memberOf Twilio
   * @description Handles POSTing requests to event-bridge with JWTs<br>
   */
  function ApiRequester(channelUrl, eventEmitter, maxRetries) {
    Object.defineProperties(this, {
          'channelUrl': {
            value: channelUrl
          },
          'eventEmitter' : {
            value : eventEmitter
          },
          'maxRetries' : {
              value : maxRetries ? maxRetries : 0
          }
        });
  }

  // private methods
  ApiRequester.prototype._handleHttpError = function _handleHttpError(code, message, completion) {
      if(completion) {
          var error = new HttpError(code, message);
          completion(error, null);
      }
  };

  ApiRequester.prototype._handleHttpSuccess = function _handleHttpSuccess(xhr, jsonParams, completion, entity) {
      var jsonResponse = JSON.parse(xhr.responseText);
      var type = jsonResponse.event_type;
      var payload = jsonResponse.payload;
      if(entity) {
          //update the entity with its latest properties from the update
          PropertyUtil.setProperties(entity, payload, entity.token, entity.apiRequester, entity.workspaceUrl);
      }
      if(type) {
          this.eventEmitter._emitMessage(type, payload);
      }
      if(completion) {
          this.eventEmitter._sendResponse(completion, payload);
      }
  };

  ApiRequester.prototype._handleHttpFailure = function _handleHttpFailure(xhr, jsonParams, completion, entity, retryCount) {
      var status = xhr.status;
      var message = xhr.statusText;
      //  0 - time out on request -  retry up to 5 times; throw error to user
      //400 - bad parsing of json - throw error to user
      //401 - JWT expiration; send a message to generate a new one - throw error to user
      //403 - JWT verification problem - invalid jwt or policy access issue - throw error to user
      //404 - invalid endpoint - throw error to user
      //500 - issues with account service or API; after retries, throw error to user
      if(status === 0 || status === 500) {
          if (status === 0) {
              console.log("Timeout on request, retrying");
          }

          // retry on timeouts & internal server error
          this._retry(xhr, jsonParams, completion, entity, retryCount);
      }else {
          // any other message should alert the user
          this._handleHttpError(status, message, completion);
      }
  };

  ApiRequester.prototype._retry = function _retry(xhr, jsonParams, completion, entity, retryCount) {
      if(retryCount == this.maxRetry) {
          console.log("Retries exhausted after " + retryCount + " attempts");
          this._handleHttpError(xhr.status, xhr.statusText, completion);
          return;
      }else {
          console.log("Retrying");
          if(retryCount < this.maxRetry) {
              this._postMessage(jsonParams, completion, entity, retryCount+1);
          }
      }
  };

  ApiRequester.prototype._handleHttpResponse = function _handleHttpResponse(xhr, completion, jsonParams, entity, retryCount) {
      //only handle completes
      if(xhr.readyState == 4) {
          if(xhr.status == 200) {
              return this._handleHttpSuccess(xhr, jsonParams, completion, entity);
          }else {
              return this._handleHttpFailure(xhr, jsonParams, completion, entity, retryCount);
          }
      }
  };

  ApiRequester.prototype._postMessage = function _postMessage(jsonParams, completion, entity, retryCount) {
      retryCount = retryCount ? retryCount : 0;

      var xhr = new XMLHttpRequest();
      xhr.overrideMimeType("application/json");
      xhr.open("POST", this.channelUrl, true);
      var self = this;

      xhr.onreadystatechange = function() {
          self._handleHttpResponse(this, completion, jsonParams, entity, retryCount);
      };

      xhr.timeout = 5000;
      xhr.send(jsonParams);
  };

  ApiRequester.prototype._postMessageSync = function _postMessageSync(jsonParams, completion, entity, retryCount) {
      retryCount = retryCount ? retryCount : 0;

      var xhr = new XMLHttpRequest();
      xhr.overrideMimeType("application/json");
      xhr.open("POST", this.channelUrl, false);
      var self = this;

      xhr.onreadystatechange = function() {
          self._handleHttpResponse(this, completion, jsonParams, entity, retryCount);
      };

      xhr.send(jsonParams);

      console.log("Sync XHR request issued");
  };

  ApiRequester.prototype._sendBeacon = function _sendBeacon(data) {
      navigator.sendBeacon(this.channelUrl, data);

      console.log("Beacon API request issued");
  };

  /**
   * Use Beacon if the API exists and the browser in use has good compatibility.
   * @returns {boolean} true if Beacon API should be used, false otherwise.
   * @private
   */
  ApiRequester.prototype._useBeacon = function _useBeacon() {
      var isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

      return "sendBeacon" in navigator &&
             !isSafari;
  };

  module.exports = ApiRequester;

  },{"./httperror":8,"./util/property":35}],2:[function(require,module,exports){
  var EventEmitter = require('events').EventEmitter;
  var inherits = require('util').inherits;
  var JWTUtil = require('../util/jwt');
  var ApiRequester = require('../api.requester');
  var Heartbeat = require("./heartbeat").Heartbeat;

  /**
   * @author jwitz
   * @version 1.1.0
   *
   * Handles generic Event-Bridge handling of event-bridge requests, responses and events
   * Handles setting up of websockets
   * Handles token expiration
   *
   * @constructor
   * @param {string} token - The JWT access token
   * @param {string} channelUrl - the websocket channel url
   * @param {string} readyUrl - REST API url to issue a GET request to upon the websocket being opened
   * @param {string} debug - JS SDK will output events to console (defaults to true)
   * @param {int} maxRetries - Number of retries to invoke if an HTTP request fails.
   * @extends EventEmitter
   * @requires Atmosphere-Client
   * @requires ApiRequester
   * @requires JWTUtil
   * @memberOf Twilio
   */
  function EventBridgeClient(token, channelUrl, readyUrl, debug, maxRetries) {
      if(!token){
          throw new Error("Token is required for TaskRouter JS SDK");
      }
      EventEmitter.call(this);

      this.token = token;
      if(debug === false || debug === "false") {
          this.debug = false;
      }else {
          this.debug = true;
      }

      // API Requester uses XHR https requests
      var apiRequester = new ApiRequester(channelUrl, this, maxRetries);

      // Web Socket connects with wss request
      channelUrl = channelUrl.replace("https", "wss");

      Object.defineProperties(this, {
          'channelUrl': {
            value: channelUrl
          },
          'apiRequester': {
            value : apiRequester
          },
          'readyUrl' : {
            value : readyUrl
          }
        });

      var jwt = JWTUtil.objectize(token);
      var expired = jwt.exp;
      var now = Math.round(new Date().getTime() / 1000);
      var diff = expired - now - 5; //couple seconds buffer for token expired

      var self = this;
      this.tokenTimer = setTimeout(function() {
          self._emitTokenExpired();
      }, diff * 1000);

      //Check for minimum payload values
      //like account,channel,workspace_sid
      if(!jwt.account_sid  || !jwt.channel  || !jwt.workspace_sid ) {
          throw new Error("Missing minimum payload values. Check for existence of account_sid,channel or workspace_sid in the token");
      }

      self._setupWebsocket();
  }
  inherits(EventBridgeClient, EventEmitter);

  /**
   * Update the JWT with a non-expired one
   * @param {string} token - new token
   */
  EventBridgeClient.prototype.updateToken = function updateToken(token) {
      this.token = token;
      clearTimeout(this.tokenTimer); // clear the previous timer for emitting token expiration event
      var jwt = JWTUtil.objectize(token);
      var expired = jwt.exp;
      var now = Math.round(new Date().getTime() / 1000);
      var diff = expired - now - 5; //couple seconds buffer for token expired
      var self = this;
      this.tokenTimer = setTimeout(function() {
          self._emitTokenExpired();
      }, diff * 1000);
  };

  // private methods
  /**
   * Emits a message to a client based on the event type and json payload
   * @param {string} type - event type
   * @param {string} payload - json payload
   * @private
   */
  EventBridgeClient.prototype._emitMessage = function _emitMessage(type, payload) {
      this.emit(type, payload);
  };

  /**
   * Sends a response from a REST API request to a completion function
   * @param {function} completion - async function to run upon completion
   * @param {json} payload - json payload
   * @private
   */
  EventBridgeClient.prototype._sendResponse = function _sendResponse(completion, payload) {
      completion(null, payload);
  };

  /**
   * Emits a token expired event
   * @private
   */
  EventBridgeClient.prototype._emitTokenExpired = function _emitTokenExpired() {
      this._emitMessage("token.expired");
  };

  /**
   * Logs a Message to the console and emits websocket error responses
   * @private
   */
  EventBridgeClient.prototype._log = function _log(message, errorResponse) {
      if(this.debug) {
          console.log(message);
      }
      if(errorResponse) {
          var error = {
              'response': errorResponse,
              'message' : message
          };
          this.emit('error', error);
      }
  };

  /**
   * Setup a websocket connection
   * @private
   */
  EventBridgeClient.prototype._setupWebsocket = function _setupWebsocket() {

      var queryParam = "";
      if(this.closeExistingSessions === true || this.closeExistingSessions === "true") {
          queryParam += "&closeExistingSessions=true";
      }else {
          queryParam += "&closeExistingSessions=false";
      }
      if(typeof(this.disconnectActivitySid) !== "undefined" && this.disconnectActivitySid !== null) {
          queryParam += ("&disconnectActivitySid=" + this.disconnectActivitySid);
      }
      var self = this;
      var channelUrl = self.channelUrl;
      var attempts = 1;

      // cancel out any previous heartbeat
      if (this.heartbeat) {
          this.heartbeat.onsleep = function() {};
      }
      this.heartbeat = new Heartbeat({ "interval": 60 });

      createWebSocket();

      // Create a websocket connection
      function createWebSocket() {
          var ws = new WebSocket(channelUrl+"?token="+self.token + queryParam);
          ws.onopen = function() {
              // reset the tries back to 1 since we have a new connection opened.
              attempts = 1;

              self._log('Websocket opened: '+ws.url);
              self._fetchResourceOnReady();
              self._emitMessage('connected');

              // setup heartbeat onsleep and beat it once to get timer started
              self.heartbeat.onsleep = function() {
                // treat it like the socket closed because when network drops onclose does not get called right away
                self._log("Heartbeat timed out. closing socket");
                ws.onclose();
              };
              self.heartbeat.beat();
          };
          ws.onmessage = function(response) {
              self.heartbeat.beat();

              // Receives a message
              if(response.data.trim().length === 0) {
                  // heartbeat received
                  return;
              }
              var json;
              try {
                  json = JSON.parse(response.data);
              } catch (e) {
                  self._log(e);
                  self._log('This doesn\'t look like a valid JSON: ' + response.data, response);
                  return;
              }
              var type = json.event_type;
              var payload = json.payload;
              self._emitMessage(type, payload);
          };
          ws.onerror = function(response) {
              self._log("Websocket had an error", response);
          };
          ws.onclose = function(response) {
              self._log("Websocket closed");
              var payload = {'message': 'Websocket disconnected due to lost connectivity'};
              self._emitMessage('disconnected', payload);
              var time = generateInterval(attempts);

              // clear the heartbeat onsleep callback
              self.heartbeat.onsleep = function() {};

              setTimeout(function () {
                  // We've tried to reconnect so increment the attempts by 1
                  attempts++;

                  // Connection has closed so try to reconnect every 10 seconds.
                  createWebSocket();
              }, time);

          };
      }

      // Generate a backoff interval to retry connecting
      function generateInterval (k) {
          return Math.min(30, (Math.pow(2, k) - 1)) * 1000;
      }
  };

  module.exports = EventBridgeClient;

  },{"../api.requester":1,"../util/jwt":34,"./heartbeat":3,"events":39,"util":44}],3:[function(require,module,exports){
  /**
   * Heartbeat just wants you to call <code>beat()</code> every once in a while.
   *
   * <p>It initializes a countdown timer that expects a call to
   * <code>Hearbeat#beat</code> every n seconds. If <code>beat()</code> hasn't
   * been called for <code>#interval</code> seconds, it emits a
   * <code>onsleep</code> event and waits. The next call to <code>beat()</code>
   * emits <code>onwakeup</code> and initializes a new timer.</p>
   *
   * <p>For example:</p>
   *
   * @example
   *
   *     >>> hb = new Heartbeat({
   *     ...   interval: 10,
   *     ...   onsleep: function() { console.log('Gone to sleep...Zzz...'); },
   *     ...   onwakeup: function() { console.log('Awake already!'); },
   *     ... });
   *
   *     >>> hb.beat(); # then wait 10 seconds
   *     Gone to sleep...Zzz...
   *     >>> hb.beat();
   *     Awake already!
   *
   * @exports Heartbeat as Twilio.Heartbeat
   * @memberOf Twilio
   * @constructor
   * @param {object} opts Options for Heartbeat
   * @config {int} [interval=10] Seconds between each call to <code>beat</code>
   * @config {function} [onsleep] Callback for sleep events
   * @config {function} [onwakeup] Callback for wakeup events
   */
  function Heartbeat(opts) {
    if (!(this instanceof Heartbeat)) return new Heartbeat(opts);
    opts = opts || {};
    /** @ignore */
    var noop = function() { };
    var defaults = {
      interval: 10,
      now: function() { return new Date().getTime(); },
      repeat: function(f, t) { return setInterval(f, t); },
      stop: function(f, t) { return clearInterval(f, t); },
      onsleep: noop,
      onwakeup: noop
    };
    for (var prop in defaults) {
      if (prop in opts) continue;
      opts[prop] = defaults[prop];
    }
    /**
     * Number of seconds with no beat before sleeping.
     * @type number
     */
    this.interval = opts.interval;
    this.lastbeat = 0;
    this.pintvl = null;

    /**
     * Invoked when this object has not received a call to <code>#beat</code>
     * for an elapsed period of time greater than <code>#interval</code>
     * seconds.
     *
     * @event
     */
    this.onsleep = opts.onsleep;

    /**
     * Invoked when this object is sleeping and receives a call to
     * <code>#beat</code>.
     *
     * @event
     */
    this.onwakeup = opts.onwakeup;

    this.repeat = opts.repeat;
    this.stop = opts.stop;
    this.now = opts.now;
  }

  /**
   * @return {string}
   */
  Heartbeat.toString = function() {
    return "[Twilio.Heartbeat class]";
  };

  /**
   * @return {string}
   */
  Heartbeat.prototype.toString = function() {
    return "[Twilio.Heartbeat instance]";
  };
  /**
   * Keeps the instance awake (by resetting the count down); or if asleep,
   * wakes it up.
   */
  Heartbeat.prototype.beat = function() {
    this.lastbeat = this.now();
    if (this.sleeping()) {
      if (this.onwakeup) {
        this.onwakeup();
      }
      var self = this;
      this.pintvl = this.repeat.call(
        null,
        function() { self.check(); },
        this.interval * 1000
      );
    }
  };
  /**
   * Goes into a sleep state if the time between now and the last heartbeat
   * is greater than or equal to the specified <code>interval</code>.
   */
  Heartbeat.prototype.check = function() {
    var timeidle = this.now() - this.lastbeat;
    if (!this.sleeping() && timeidle >= this.interval * 1000) {
      if (this.onsleep) {
        this.onsleep();
      }
      this.stop.call(null, this.pintvl);

      this.pintvl = null;
    }
  };
  /**
   * @return {boolean} True if sleeping
   */
  Heartbeat.prototype.sleeping = function() {
    return this.pintvl === null;
  };
  exports.Heartbeat = Heartbeat;
  },{}],4:[function(require,module,exports){
  var TaskRouterEventBridgeClient = require('./taskrouter-event-bridge-client');
  var JWTUtil = require('../util/jwt');
  var TaskQueue = require('../resources/instance/taskqueue');

  /**
   *
   * @version 1.1.0
   *
   * Handles TaskQueue related handling of event-bridge requests, responses and events
   *
   * @constructor
   * @param {string} token - The JWT access token for the workspace
   * @param {string} debug - JS SDK will output events to console (defaults to true)
   * @param {string} region - the ingress region for event-bridge connections
   * @param {int} maxRetries - Number of retries to invoke if an HTTP request fails.
   * @param {string} apiBaseUrl - base TaskRouter REST API endpoint
   * @param {string} eventBridgeBaseUrl - base Event-Bridge endpoint
   * @extends TaskRouterEventBridgeClient
   * @requires JWTUtil
   * @memberOf Twilio.TaskRouter
   * @description Registers a Twilio TaskRouter TaskQueue JS client
   */
  function TaskQueueClient(token, debug, region, maxRetries, apiBaseUrl, eventBridgeBaseUrl) {
      if(!token){
          throw new Error("Token is required for TaskRouter JS SDK");
      }
      var jwt = JWTUtil.objectize(token);
      var taskqueueSid = jwt.taskqueue_sid;

      TaskRouterEventBridgeClient.call(this, token, apiBaseUrl, eventBridgeBaseUrl, region, taskqueueSid, "/TaskQueues/"+taskqueueSid, debug, maxRetries);

      var taskqueue = new TaskQueue(token, taskqueueSid, this.apiRequester, this.workspaceUrl);
      this._taskqueue = taskqueue;

      // expose all properties on a taskqueue on the taskqueue client
      // so they can be easily accessible to the developer
      for (var property in taskqueue) {
          if(!this.hasOwnProperty(property) && property !== 'updateToken') {
              var propertyValue = taskqueue[property];
              Object.defineProperty(this, property, {
                  enumerable: true,
                  value: propertyValue
              });
          }
      }
  }
  TaskQueueClient.prototype = Object.create(TaskRouterEventBridgeClient.prototype);

  /**
   * Update the JWT with a non-expired one
   * @param {string} token - new token
   */
  TaskQueueClient.prototype.updateToken = function updateToken(token) {
      this._taskqueue.updateToken(token);
      TaskRouterEventBridgeClient.prototype.updateToken.call(this, token);
  };

  module.exports = TaskQueueClient;
  },{"../resources/instance/taskqueue":14,"../util/jwt":34,"./taskrouter-event-bridge-client":5}],5:[function(require,module,exports){
  var inherits = require('util').inherits;
  var EventBridgeClient = require('./event-bridge-client');
  var JWTUtil = require('../util/jwt');
  var EntityUtil = require('../util/entity');
  var PropertyUtil = require('../util/property');

  /**
   * @author jwitz
   * @version 1.1.0
   *
   * Handles WDS Specific Event-Bridge handling of event-bridge requests, responses and events
   *
   * @constructor
   * @param {string} token - The JWT access token
   * @param {string} wdsBaseUrl - base WDS REST API endpoint
   * @param {string} eventBridgeBaseUrl - base Event-Bridge endpoint
   * @param {string} region - the ingress region for event-bridge connections
   * @param {string} channelId - the websocket channel
   * @param {string} readyPath - WDS REST API path relative to a WorkspaceSid
   * @param {string} debug - JS SDK will output events to console (defaults to true)
   * @param {int} maxRetries - Number of retries to invoke if an HTTP request fails.
   * @extends EventBridgeClient
   * @requires JWTUtil
   * @requires EntityUtil
   * @memberOf Twilio.TaskRouter
   */
  function TaskRouterEventBridgeClient(token, wdsBaseUrl, eventBridgeBaseUrl, region, channelId, readyPath, debug, maxRetries) {
      if(!token){
          throw new Error("Token is required for WDS client");
      }

      var jwt = JWTUtil.objectize(token);

      var accountSid = jwt.account_sid;
      var workspaceSid = jwt.workspace_sid;

      // wds location
      wdsBaseUrl = wdsBaseUrl ? wdsBaseUrl : 'https://taskrouter.twilio.com/v1';
      var workspaceUrl = wdsBaseUrl+"/Workspaces/"+workspaceSid;

      // GET path to fire off open connecting, tied to 'ready' event
      var readyUrl;
      if(readyPath) {
          readyUrl = workspaceUrl+readyPath;
      }

      // event-bridge location
      eventBridgeBaseUrl = eventBridgeBaseUrl ? eventBridgeBaseUrl : 'https://event-bridge.twilio.com';
      if (region) {
          eventBridgeBaseUrl = eventBridgeBaseUrl.split("twilio.com")[0] + region + ".us1.twilio.com";
      }
      var baseUrl = eventBridgeBaseUrl+'/v1/wschannels/'+accountSid+'/';
      var channelUrl = baseUrl+channelId;
      this.token = token;

      Object.defineProperties(this, {
          'workspaceUrl': {
              value: workspaceUrl
          },
          'resourceUrl' : {
              value : readyUrl
          }
      });

      EventBridgeClient.call(this, token, channelUrl, readyUrl, debug, maxRetries);
  }
  TaskRouterEventBridgeClient.prototype = Object.create(EventBridgeClient.prototype);

  // private methods
  /**
   * Emits a message to a client based on the event type and json payload
   * @param {string} type - event type
   * @param {json} payload - json payload to either convert into an object or send raw to the client
   * @private
   */
  TaskRouterEventBridgeClient.prototype._emitMessage = function _emitMessage(type, payload) {
      var log = 'Received a message of type ['+ type + ']';

      // emit based on object or
      // emit based on json payload
      if(type) {
          var entity = EntityUtil.createEntity(payload, this.token, this.apiRequester, this.workspaceUrl);
          if(entity) {
              log = log + ' with object '+JSON.stringify(entity);
              this.emit(type, entity);
          }else {
              if(payload) {
                  log = log + ' with json payload '+JSON.stringify(payload);
              }
              this.emit(type, payload);
          }
      }
      this._log(log);
  };

  /**
   * Sends a response from a REST API request to a completion function
   * @param {function} completion - async function to run upon completion
   * @param {json} payload - json payload to either convert into an object or send raw to the client
   * @private
   */
  TaskRouterEventBridgeClient.prototype._sendResponse = function _sendResponse(completion, payload) {
      var entity = EntityUtil.createEntity(payload, this.token, this.apiRequester, this.workspaceUrl);
      if(entity) {
          var sid = entity.sid;
          if(sid && sid.substring(0, 2) === 'WR') {
              var promise = PropertyUtil.setTaskProperty(entity);
              promise.then(function(entity) {
                  completion(null, entity);
              });
          }else {
              completion(null, entity);
          }
      } else {
          completion(null, payload);
      }
  };

  /**
   * Fetches a resource tied to the client upon ready
   * @private
   */
  TaskRouterEventBridgeClient.prototype._fetchResourceOnReady = function _fetchResourceOnReady() {
      var request = {"url": this.resourceUrl, "method":"GET", "event_type":"ready", "token" : this.token};
      var jsonParams = JSON.stringify(request);
      this.apiRequester._postMessage(jsonParams);
  };

  module.exports = TaskRouterEventBridgeClient;

  },{"../util/entity":33,"../util/jwt":34,"../util/property":35,"./event-bridge-client":2,"util":44}],6:[function(require,module,exports){
  var TaskRouterEventBridgeClient = require('./taskrouter-event-bridge-client');
  var JWTUtil = require('../util/jwt');
  var EntityUtil = require('../util/entity');
  var PropertyUtil = require('../util/property');
  var Task = require('../resources/instance/task');
  var Reservation = require('../resources/instance/reservation');
  var Worker = require('../resources/instance/worker');
  var ActivityList = require('../resources/list/activities');

  /**
   * @author jwitz
   * @version 1.1.0
   *
   * Handles Worker related handling of event-bridge requests, responses and events
   *
   * @constructor
   * @param {string} token - The JWT access token for the worker
   * @param {string} debug - JS SDK will output events to console (defaults to true)
   * @param {string} connectActivitySid - ActivitySid to place the worker in upon connecting
   * @param {string} disconnectActivitySid - ActivitySid to place the worker in upon disconnecting
   * @param {boolean} closeExistingSessions - close existing connections for a given channel (defaults to false)
   * @param {string} region - the ingress region for event-bridge connections
   * @param {int} maxRetries - Number of retries to invoke if an HTTP request fails.
   * @param {string} apiBaseUrl - base TaskRouter REST API endpoint
   * @param {string} eventBridgeBaseUrl - base Event-Bridge endpoint
   * @extends TaskRouterEventBridgeClient
   * @requires JWTUtil
   * @requires EntityUtil
   * @memberOf Twilio.TaskRouter
   * @description Registers a Twilio TaskRouter Worker JS client
   */
  function WorkerClient(token, debug, connectActivitySid, disconnectActivitySid, closeExistingSessions, region,
                        maxRetries, apiBaseUrl, eventBridgeBaseUrl) {
      if (!token) {
          throw new Error("Token is required for TaskRouter JS SDK");
      }
      var jwt = JWTUtil.objectize(token);
      var workerSid = jwt.worker_sid;

      Object.defineProperties(this, {
          'workerSid': {
              value: workerSid
          },
          'connectActivitySid': {
              value: connectActivitySid
          },
          'disconnectActivitySid': {
              value: disconnectActivitySid
          },
          'closeExistingSessions': {
              value: closeExistingSessions
          }
      });

      var readyPath = "/Workers/" + workerSid;
      TaskRouterEventBridgeClient.call(this, token, apiBaseUrl, eventBridgeBaseUrl, region, workerSid, readyPath, debug,
                                       maxRetries);

      var worker = new Worker(token, workerSid, this.apiRequester, this.workspaceUrl);
      this._worker = worker;
      var activityList = new ActivityList(token, this.apiRequester, this.workspaceUrl);

      Object.defineProperties(this, {
          'activities': {
              value: activityList
          }
      });

      // expose all properties on a worker on the worker client
      // so they can be easily accessible to the developer
      for (var property in worker) {
          if (!this.hasOwnProperty(property) && property !== 'updateToken') {
              var propertyValue = worker[property];
              Object.defineProperty(this, property, {
                  enumerable: true,
                  value: propertyValue
              });
          }
      }
  }

  WorkerClient.prototype = Object.create(TaskRouterEventBridgeClient.prototype);

  /**
   * Update the JWT with a non-expired one
   * @param {string} token - new token
   */
  WorkerClient.prototype.updateToken = function updateToken(token) {
      this._worker.updateToken(token);
      this.activities.updateToken(token);
      TaskRouterEventBridgeClient.prototype.updateToken.call(this, token);
  };

  /**
   * Set whether to fetch reservation details when emitting a
   * reservation event. Defaults to false.
   * @param {boolean} skip  - whether to fetch reservation details
   */
  WorkerClient.prototype.setSkipFetchReservation = function setSkipFetchReservation(skip) {
      Object.defineProperty(this, "skipFetchReservation", {
          value: skip
      });
  };

  /**
   * Fetch reservations for a worker
   * @param {function} completion - async function to run upon completion
   * @param {json} params - (optional) json formatted query parameters
   */
  WorkerClient.prototype.fetchReservations = function fetchReservations(completion, params) {
      var request = {
          "url": this.workspaceUrl + "/Workers/" + this.workerSid + "/Reservations",
          "method": "GET",
          "token": this.token
      };
      if (params) {
          request.params = params;
      }
      var jsonParams = JSON.stringify(request);

      // create a wrapper function to set task objects on reservation
      var wrapperCompletionFunc = function (error, reservations) {
          if (error) {
              completion(error);
              return;
          }
          var data = reservations.data;
          var promises = [];

          // helper function
          var setTaskProperties = function (reservation) {
              var promise = PropertyUtil.setTaskProperty(reservation);
              promises.push(promise);
          };

          // loop through reservations and set task properties
          for (i = 0; i < data.length; i++) {
              setTaskProperties(data[i]);
          }

          // only return once all promises are satisfied and thus all data is populated
          Promise.all(promises).then(function (results) {
              // return using user function
              completion(null, reservations);
          });
      };
      this.apiRequester._postMessage(jsonParams, wrapperCompletionFunc);
  };

  /**
   * Fetch all channels for a worker
   * @param {function} completion - async function to call upon completion
   */
  WorkerClient.prototype.fetchChannels = function fetchChannels(completion) {
      var jsonParams = JSON.stringify(
          {"url": this.workspaceUrl + "/Workers/" + this.workerSid + "/Channels", "method": "GET", "token": this.token});
      this.apiRequester._postMessage(jsonParams, completion);
  };

  /**
   * Update a Task
   * @param {string} taskSid - the task to complete
   * @param {json} params - json formatted POST
   * @param {function} completion - async function to call upon completion
   */
  WorkerClient.prototype.updateTask = function updateTask(taskSid, params, completion) {
      var request = {
          "url": this.workspaceUrl + "/Tasks/" + taskSid,
          "method": "POST",
          "params": params,
          "token": this.token
      };
      var jsonParams = JSON.stringify(request);
      this.apiRequester._postMessage(jsonParams, completion);
  };

  /**
   * Complete a Task
   * @param {string} taskSid - the task to complete
   * @param {function} completion - async function to call upon completion
   * @param {string} reason - (optional)
   */
  WorkerClient.prototype.completeTask = function completeTask(taskSid, completion, reason) {
      var jsonParams = JSON.stringify({
                                          "url": this.workspaceUrl + "/Tasks/" + taskSid,
                                          "method": "POST",
                                          "params": {"AssignmentStatus": "completed", "Reason": reason},
                                          "token": this.token
                                      });
      this.apiRequester._postMessage(jsonParams, completion);
  };

  /**
   * Fetch the list of activities in the workspace of the worker
   * @deprecated since version 1.1
   * @param {function} completion - async function to call upon completion
   */
  WorkerClient.prototype.fetchActivityList = function fetchActivityList(completion) {
      console.warn("Deprecated. Please utilize worker.activities.fetch(function() {}) instead.");
      var jsonParams = JSON.stringify({"url": this.workspaceUrl + "/Activities", "method": "GET", "token": this.token});
      this.apiRequester._postMessage(jsonParams, completion);
  };

  /**
   * Update the worker's activity to the Activity provided
   * @deprecated since version 1.1
   * @param {string} activitySid - the activity to update the worker to
   * @param {function} completion - async function to call upon completion
   */
  WorkerClient.prototype.updateActivity = function updateActivity(activitySid, completion) {
      console.warn("Deprecated. Please utilize worker.update({\"ActivitySid\":\"" + activitySid + "\"}, function() {}) instead.");
      var jsonParams = JSON.stringify({
                                          "url": this.workspaceUrl + "/Workers/" + this.workerSid,
                                          "method": "POST",
                                          "params": {"ActivitySid": activitySid},
                                          "token": this.token
                                      });
      this.apiRequester._postMessage(jsonParams, completion);
  };

  // private methods
  /**
   * Emits a message to a client based on the event type and json payload.
   * @param {string} type - event type
   * @param {json} payload - json payload to either convert into an object or send raw to the client
   * @private
   */
  WorkerClient.prototype._emitMessage = function _emitMessage(type, payload) {
      // since we're in the context of a worker,
      // take off worker. from event types
      if (type && type.indexOf("worker") === 0) {
          type = type.replace("worker.", "");
      }
      var self = this;

      // emit based on object or
      // emit based on json payload
      if (type) {
          var entity;
          //reservation.created, reservation.accepted, reservation.rejected, reservation.timeout, reservation.rescinded
          //reservation.canceled will happen in the case of task.canceled or task.deleted
          if (type.indexOf("reservation") === 0) {
              //have to do this because of our mashup of task+reservation_sid in the event broadcast
              var taskSid = payload.sid;
              var sid = payload.reservation_sid;
              if (type.indexOf("reservation.pending") === 0) {
                  // flip these for onload event due to mashup of task+reservation_sid in event broadcast
                  taskSid = payload.taskSid;
                  sid = payload.sid;
                  type = "reservation.created";
              }
              entity = new Reservation(this.token, sid, taskSid, this.apiRequester, this.workspaceUrl);

              // fetch a task/reservation async and then upon return emit the message
              if (this.skipFetchReservation) {
                  self._emitReservationWithoutProperties(entity, taskSid, payload, type);
              } else {
                  var promise = PropertyUtil.setReservationProperties(entity);
                  promise.then(function (reservation) {
                      self.emit(type, reservation);
                  }, function (err) {
                      self._emitReservationWithoutProperties(entity, taskSid, payload, type);
                  });
              }
          } else {
              entity = EntityUtil.createEntity(payload, this.token, this.apiRequester, this.workspaceUrl);
              if (entity) {
                  log = log + ' with object ' + JSON.stringify(entity);
                  this.emit(type, entity);
              } else {
                  if (payload) {
                      log = log + ' with json payload ' + JSON.stringify(payload);
                  }
                  this.emit(type, payload);
              }
              if (type.indexOf("ready") === 0) {
                  this._emitPendingReservations();
                  if (this.disconnectActivitySid) {
                      window.addEventListener('unload', function () {
                          self._updateWorkerToDisconnectActivity();
                      });
                  }
              }
          }
      }
      var log = 'Received a message of type [' + type + ']';
      this._log(log);
  };

  /**
   * In the absence of fetching full Reservation and Task details, emit
   * a Reservation instance with the properties contained within the event
   * payload.
   * @param {reservation} reservation - new Reservation instance
   * @param {string} taskSid - taskSid associated with reservation
   * @param {json} payload - json payload to set as properties on the reservation
   * @param {string} eventType - event type
   * @private
   */
  WorkerClient.prototype._emitReservationWithoutProperties =
      function _emitReservationWithoutProperties(reservation, taskSid, payload, eventType) {
          var task = new Task(this.token, taskSid, this.apiRequester, this.workspaceUrl);
          PropertyUtil.setProperties(task, payload, this.token, this.apiRequester, this.workspaceUrl);

          // set a task property on the reservation
          Object.defineProperties(reservation, {
              'task': {
                  value: task,
                  enumerable: true
              }
          });

          this.emit(eventType, reservation);
      };

  /**
   * Emits all pending reservations to the client
   * @private
   */
  WorkerClient.prototype._emitPendingReservations = function _emitPendingReservations() {
      var self = this;
      this._fetchPendingReservations().then(function (reservations) {
          // update the worker to the given activity if they don't have any pending reservations
          if (reservations.length === 0 && self.connectActivitySid) {
              self.update("ActivitySid", self.connectActivitySid);
          }
          for (i = 0; i < reservations.length; i++) {
              self._emitMessage("reservation.pending", reservations[i]);
          }
      }, function (error) {
          self._log(error.code + ' with ' + error.message);
      });
  };

  /**
   * Fetches all pending resrvations
   * @private
   */
  WorkerClient.prototype._fetchPendingReservations = function _fetchPendingReservations() {
      var queryParams = {"ReservationStatus": "pending"};
      var self = this;
      return new Promise(function (resolve, reject) {
          self.fetchReservations(
              function (error, reservations) {
                  if (error) {
                      reject(error);
                      return;
                  }
                  var data = reservations.data;
                  resolve(data);
              },
              queryParams
          );
      });
  };

  /**
   * Sends a Worker to their disconnected activity upon a window closing
   * @private
   */
  WorkerClient.prototype._updateWorkerToDisconnectActivity = function _updateWorkerToDisconnectActivity() {
      var params = {ActivitySid: this.disconnectActivitySid};
      var request = JSON.stringify({"url": this.resourceUrl, "method": "POST", "params": params, "token": this.token});

      if (this.apiRequester._useBeacon()) {
          this.apiRequester._sendBeacon(request);
      }
      else {
          this.apiRequester._postMessageSync(request);
      }
  };

  module.exports = WorkerClient;

  },{"../resources/instance/reservation":11,"../resources/instance/task":13,"../resources/instance/worker":16,"../resources/list/activities":20,"../util/entity":33,"../util/jwt":34,"../util/property":35,"./taskrouter-event-bridge-client":5}],7:[function(require,module,exports){
  var TaskRouterEventBridgeClient = require('./taskrouter-event-bridge-client');
  var JWTUtil = require('../util/jwt');
  var Workspace = require('../resources/instance/workspace');

  /**
   * @author jwitz
   * @version 1.1.0
   *
   * Handles Worker related handling of event-bridge requests, responses and events
   *
   * @constructor
   * @param {string} token - The JWT access token for the workspace
   * @param {string} debug - JS SDK will output events to console (defaults to true)
   * @param {string} region - the ingress region for event-bridge connections
   * @param {int} maxRetries - Number of retries to invoke if an HTTP request fails.
   * @param {string} apiBaseUrl - base TaskRouter REST API endpoint
   * @param {string} eventBridgeBaseUrl - base Event-Bridge endpoint
   * @extends TaskRouterEventBridgeClient
   * @requires JWTUtil
   * @memberOf Twilio.TaskRouter
   * @description Registers a Twilio TaskRouter Workspace JS client
   */
  function WorkspaceClient(token, debug, region, maxRetries, apiBaseUrl, eventBridgeBaseUrl) {
      if(!token){
          throw new Error("Token is required for TaskRouter JS SDK");
      }
      var jwt = JWTUtil.objectize(token);
      var workspaceSid = jwt.workspace_sid;

      TaskRouterEventBridgeClient.call(this, token, apiBaseUrl, eventBridgeBaseUrl, region, workspaceSid, "/", debug, maxRetries);

      var workspace = new Workspace(token, this.apiRequester, this.workspaceUrl);
      this._workspace = workspace;

      // expose all properties on a workspace on the workspace client
      // so they can be easily accessible to the developer
      for (var property in workspace) {
          if(!this.hasOwnProperty(property) && property !== 'updateToken') {
              var propertyValue = workspace[property];
              Object.defineProperty(this, property, {
                  enumerable: true,
                  value: propertyValue
              });
          }
      }
  }
  WorkspaceClient.prototype = Object.create(TaskRouterEventBridgeClient.prototype);

  /**
   * Update the JWT with a non-expired one
   * @param {string} token - new token
   */
  WorkspaceClient.prototype.updateToken = function updateToken(token) {
      this._workspace.updateToken(token);
      TaskRouterEventBridgeClient.prototype.updateToken.call(this, token);
  };

  module.exports = WorkspaceClient;

  },{"../resources/instance/workspace":19,"../util/jwt":34,"./taskrouter-event-bridge-client":5}],8:[function(require,module,exports){
  function HttpError(code, message) {

    Object.defineProperties(this, {
          'code': {
            value: code
          },
          'message': {
            value: message
          }
        });
  }

  module.exports = HttpError;
  },{}],9:[function(require,module,exports){
  function TaskRouter() { }

  Object.defineProperties(TaskRouter, {
    TaskQueue: {
      enumerable: true,
      value: require('./clients/taskqueue-client')
    },
    Worker: {
      enumerable: true,
      value: require('./clients/worker-client')
    },
    Workspace: {
      enumerable: true,
      value: require('./clients/workspace-client')
    }
  });

  module.exports = TaskRouter;

  },{"./clients/taskqueue-client":4,"./clients/worker-client":6,"./clients/workspace-client":7}],10:[function(require,module,exports){
  var TaskRouterResource = require('./taskrouter-resource');
  /**
   * @author jwitz
   * @version 1.1.0
   *
   * @constructor
   * @param {string} token - The JWT access token
   * @param {string} sid - the sid of the activity
   * @param {string} apiRequester - issues the api request
   * @param {string} workspaceUrl - REST API workspace url
   * @memberOf Twilio.TaskRouter
   * @description Creates a Twilio TaskRouter Activity which can fetch its attributes
   */
  function Activity(token, sid, apiRequester, workspaceUrl) {
      var resourceUrl = workspaceUrl+"/Activities/"+sid;
      TaskRouterResource.call(this, token, resourceUrl, apiRequester, workspaceUrl);
  }
  Activity.prototype = Object.create(TaskRouterResource.prototype);

  module.exports = Activity;

  },{"./taskrouter-resource":15}],11:[function(require,module,exports){
  var TaskRouterResource = require('./taskrouter-resource');
  var Task = require('./task');

  /**
   * @author jwitz
   * @version 1.1.0
   *
   * @constructor
   * @param {string} token - The JWT access token
   * @param {string} sid - reservation sid
   * @param {string} taskSid - task sid
   * @param {string} apiRequester - issues the api request
   * @param {string} workspaceUrl - REST API workspace url
   * @memberOf Twilio.TaskRouter
   * @description Creates a Twilio TaskRouter Reservation which can:<br>
   * - Accept a Reservation<br>
   * - Reject a Reservation<br>
   * - Dequeue a Call & Accept a Reservation<br>
   * - Dial & Accept a Reservation<br>
   */
  function Reservation(token, sid, taskSid, apiRequester, workspaceUrl) {
      var task = new Task(token, taskSid, apiRequester, workspaceUrl);
      var resourceUrl = workspaceUrl+"/Tasks/"+taskSid+"/Reservations/"+sid;
      this.task = task;
      this.sid = sid;

      TaskRouterResource.call(this, token, resourceUrl, apiRequester, workspaceUrl);
  }
  Reservation.prototype = Object.create(TaskRouterResource.prototype);

  /**
   * Accept the reservation
   * @param {function} completion - (optional) function to call upon the completion of task acceptance
   */
  Object.defineProperty(Reservation.prototype, 'accept', {
      value: function (completion) {
          var jsonParams = JSON.stringify(
              {
                  "url": this.resourceUrl,
                  "method": "POST",
                  "token": this.token,
                  "params": {
                      "ReservationStatus": "accepted"
                  }
              });
          this.apiRequester._postMessage(jsonParams, completion);
      },
      enumerable: false
  });

  /**
   * Reject the reservation
   * @param {string} activitySid - (optional) The activitySid to update the worker to after rejecting the task
   * @param {function} completion - (optional) function to call upon the completion of the rejection of task
   */
  Object.defineProperty(Reservation.prototype, 'reject', {
      value: function (activitySid, completion) {
          var jsonParams = JSON.stringify(
              {
                  "url": this.resourceUrl,
                  "method": "POST",
                  "token": this.token,
                  "params": {
                      "ReservationStatus": "rejected",
                      "WorkerActivitySid": activitySid
                  }
              });
          this.apiRequester._postMessage(jsonParams, completion);
      },
      enumerable: false
  });

  /**
   * Dequeue the reservation
   * @param {string} dequeueFrom - (required) The caller id for the call to the worker
   * @param {string} dequeuePostWorkActivitySid - (optional) The activitySid to update the worker to after dequeue
   * @param {string} dequeueRecord - (optional) Determines if we should record both legs of the call
   * @param {string} dequeueTimeout - (optional) The number of seconds Twilio should allow ringing to occur
   * @param {string} dequeueStatusCallbackUrl - (optional) A URL that Twilio will send asynchronous webhook requests to on completed call even
   * @param {string} dequeueStatusCallbackEvents (optional) which dequeue status callbacks you can receive
   * @param {string} dequeueTo - (optional) The contact information to dequeue the call to the worker
   * @param {function} completion - (optional) function to call upon the completion of the dequeue
   */
  Object.defineProperty(Reservation.prototype, 'dequeue', {
      value: function (dequeueFrom, dequeuePostWorkActivitySid, dequeueRecord, dequeueTimeout, dequeueStatusCallbackUrl, dequeueStatusCallbackEvents, dequeueTo, completion) {
          var jsonParams = JSON.stringify(
              {
                  "url": this.resourceUrl,
                  "method": "POST",
                  "token": this.token,
                  "params": {
                      "Instruction": "dequeue",
                      "DequeuePostWorkActivitySid": dequeuePostWorkActivitySid,
                      "DequeueFrom": dequeueFrom,
                      "DequeueRecord": dequeueRecord,
                      "DequeueTimeout": dequeueTimeout,
                      "DequeueStatusCallbackUrl": dequeueStatusCallbackUrl,
                      "DequeueStatusCallbackEvent": dequeueStatusCallbackEvents,
                      "DequeueTo": dequeueTo
                  }
              });
          this.apiRequester._postMessage(jsonParams, completion);
      },
      enumerable: false
  });

  /**
   * Dial the reservation
   * @param {string} callFrom - (required) The caller id for the call to the worker
   * @param {string} callUrl - (required) A valid TwiML URI that is executed on the answering Worker's leg
   * @param {string} callStatusCallbackUrl - (optional) A valid status callback url
   * @param {string} callAccept - (optional) true or false, accept the task before initiating call. Defaults to false
   * @param {string} callRecord - (optional) record-from-answer or none. Record the call. Defaults to none.
   * @param {string} callTo - (optional) Whom to call. If not provided, will utilize worker's "contact_uri" attribute
   * @param {function} completion - (optional) function to call upon the completion of the dial
   */
  Object.defineProperty(Reservation.prototype, 'call', {
      value: function (callFrom, callUrl, callStatusCallbackUrl, callAccept, callRecord, callTo, completion) {
          var jsonParams = JSON.stringify(
              {
                  "url": this.resourceUrl,
                  "method": "POST",
                  "token": this.token,
                  "params": {
                      "Instruction" : "call",
                      "CallFrom": callFrom,
                      "CallUrl": callUrl,
                      "CallStatusCallbackUrl": callStatusCallbackUrl,
                      "CallAccept": callAccept,
                      "CallRecord": callRecord,
                      "CallTo": callTo
                  }
              });
          this.apiRequester._postMessage(jsonParams, completion);
      },
      enumerable: false
  });

  /**
   * Redirect the reservation's call
   * @param {string} redirectCallSid - (required) The Call to Redirect
   * @param {string} redirectCallUrl - (required) The TwiML URL to Redirect the Call to
   * @param {string} redirectAccept - (optional) true or false, accept the task before redirecting call. Defaults to false
   * @param {function} completion - (optional) function to call upon the completion of the redirect
   */
  Object.defineProperty(Reservation.prototype, 'redirect', {
      value: function (redirectCallSid, redirectCallUrl, redirectAccept, completion) {
          var jsonParams = JSON.stringify(
              {
                  "url": this.resourceUrl,
                  "method": "POST",
                  "token": this.token,
                  "params": {
                      "Instruction" : "redirect",
                      "RedirectCallSid": redirectCallSid,
                      "RedirectUrl": redirectCallUrl,
                      "RedirectAccept": redirectAccept
                  }
              });
          this.apiRequester._postMessage(jsonParams, completion);
      },
      enumerable: false
  });

  /**
   * Conference the reservation
   * @param {string} from - (optional) The caller id for the call to the worker
   * @param {string} postWorkActivitySid - (optional) The activitySid to update the worker to after dequeue
   * @param {string} timeout - (optional) The number of seconds Twilio should allow ringing to occur
   * @param {string} to - (optional) The contact information to dequeue the call to the worker
   * @param {string} options - (optional) any additional participant api parameters
   * @param {function} completion - (optional) function to call upon the completion of the dequeue
   */
  Object.defineProperty(Reservation.prototype, 'conference', {
      value: function (from, postWorkActivitySid, timeout, to, completion, options) {
          var params = { "Instruction": "conference" };

          // check options
          params = Object.assign(params, {
              From: from,
              PostWorkActivitySid: postWorkActivitySid,
              Timeout: timeout,
              To: to,
          }, options);

          var json = {
                  "url": this.resourceUrl,
                  "method": "POST",
                  "token": this.token,
                  "params": params };
          var jsonParams = JSON.stringify(json);
          this.apiRequester._postMessage(jsonParams, completion);
      },
      enumerable: false
  });


  module.exports = Reservation;

  },{"./task":13,"./taskrouter-resource":15}],12:[function(require,module,exports){
  /**
   * @author jwitz
   * @version 1.1.0
   *
   * @constructor
   * @param {string} token - The JWT access token
   * @param {string} resourceUrl - REST API resource url
   * @param {string} apiRequester - issues the api request
   * @memberOf Twilio
   * @description Creates a Twilio Resource which can fetch or update its attributes
   */
  function Resource(token, resourceUrl, apiRequester) {
      Object.defineProperties(this, {
          'token' : {
              value: token,
              writable: true
          },
          'resourceUrl' : {
              value: resourceUrl
          },
          'apiRequester' : {
              value: apiRequester
          }
      });
  }

  /**
   * Get a resource's information
   * @param {function} completion - async function to run upon completion of the query
   */
  Resource.prototype.fetch = function fetch(completion) {
      var jsonParams = JSON.stringify({"url": this.resourceUrl, "method":"GET", "token": this.token});
      this.apiRequester._postMessage(jsonParams, completion);
  };

  /**
   * Update a resource
   * @param {json} params - json formatted POST parameters or a single attribute and value
   * @param {function} completion - async function to run upon completion of the post
   */
  Resource.prototype.update = function update() {

      // handle optional single parameters argument
      var arg0 = arguments[0];
      var arg1 = arguments[1];
      var arg2 = arguments[2];

      var params = {};
      var completion;
      if(typeof arg0 === "string") {
          // we're handling a single attribute update
          if(typeof arg1 === "string") {
              params[arg0] = arg1;
              completion = arg2;
          }else {
              throw Error("2nd argument needs to be a string value");
          }
      }else if(arg0 instanceof Object) {
          params = arg0;
          for (var key in params) {
              var value = params[key];
              if(value instanceof Object) {
                  params[key] = JSON.stringify(value);
              }
          }
          if(typeof arg1 === 'undefined' || arg1 instanceof Function) {
              completion = arg1;
          }else {
              throw Error("2nd argument needs to be a function");
          }
      }else {
          throw Error("1st argument needs to either be a string or a JSON object");
      }

      var request = JSON.stringify({"url": this.resourceUrl, "method":"POST", "params":params, "token": this.token});
      this.apiRequester._postMessage(request, completion, this);
  };

  /**
   * Delete a resource
   * @param {function} completion - async function to run upon completion of the deletion
   */
  Resource.prototype.delete = function deleteR(completion) {
      var request = JSON.stringify({"url": this.resourceUrl, "method":"DELETE", "token": this.token});
      this.apiRequester._postMessage(request, completion);
  };

  /**
   * Update the JWT with a non-expired one
   * @param {string} token - new token
   */
  Resource.prototype.updateToken = function updateToken(token) {
      this.token = token;
  };

  module.exports = Resource;

  },{}],13:[function(require,module,exports){
  var TaskRouterResource = require('./taskrouter-resource');
  /**
   * @author jwitz
   * @version 1.1.0
   *
   * @constructor
   * @param {string} token - The JWT access token
   * @param {string} sid - the sid of the task
   * @param {string} apiRequester - issues the api request
   * @param {string} workspaceUrl - REST API workspace url
   * @memberOf Twilio.TaskRouter
   * @description Creates a Twilio TaskRouter Task which can fetch its attributes
   */
  function Task(token, sid, apiRequester, workspaceUrl) {
      var resourceUrl = workspaceUrl+"/Tasks/"+sid;
      TaskRouterResource.call(this, token, resourceUrl, apiRequester, workspaceUrl);
  }
  Task.prototype = Object.create(TaskRouterResource.prototype);

  /**
   * Complete the Task
   * @param {function} completion - (optional) function to call upon the completion of task acceptance
   * @param {string} reason - (optional) reason for completion
   */
  Object.defineProperty(Task.prototype, 'complete', {
      value: function (completion, reason) {
          var jsonParams = JSON.stringify(
              {
                  "url": this.resourceUrl,
                  "method": "POST",
                  "token": this.token,
                  "params": {
                      "AssignmentStatus": "completed",
                      "Reason": reason
                  }
              });
          this.apiRequester._postMessage(jsonParams, completion);
      },
      enumerable: false
  });

  module.exports = Task;

  },{"./taskrouter-resource":15}],14:[function(require,module,exports){
  var TaskRouterResource = require('./taskrouter-resource');
  var Statistics = require('../list/statistics');
  var RealTimeStatistics = require('../list/realtime-statistics');
  var CumulativeStatistics = require('../list/cumulative-statistics');

  /**
   * @author jwitz
   * @version 1.1.0
   *
   * @constructor
   * @param {string} token - The JWT access token
   * @param {string} sid - the sid of the task queue
   * @param {string} apiRequester - issues the api request
   * @param {string} workspaceUrl - REST API workspace url
   * @memberOf Twilio.TaskRouter
   * @description Creates a Twilio TaskRouter TaskQueue which can fetch its attributes
   */
  function TaskQueue(token, sid, apiRequester, workspaceUrl) {
      var resourceUrl = workspaceUrl+"/TaskQueues/"+sid;

      var statistics = new Statistics(token, resourceUrl, apiRequester, workspaceUrl);
      var realtimeStats = new RealTimeStatistics(token, resourceUrl, apiRequester, workspaceUrl);
      var cumulativeStats = new CumulativeStatistics(token, resourceUrl, apiRequester, workspaceUrl);

      Object.defineProperties(this, {
          'statistics' : {
              value: statistics,
              enumerable: true
          },
          'realtimeStats' : {
              value: realtimeStats,
              enumerable: true
          },
          'cumulativeStats' : {
              value: cumulativeStats,
              enumerable: true
          }
      });

      TaskRouterResource.call(this, token, resourceUrl, apiRequester, workspaceUrl);
  }
  TaskQueue.prototype = Object.create(TaskRouterResource.prototype);

  /**
   * Update the JWT with a non-expired one
   * @param {string} token - new token
   */
  TaskQueue.prototype.updateToken = function updateToken(token) {
      this.token = token;
      this.statistics.updateToken(token);
  };

  module.exports = TaskQueue;

  },{"../list/cumulative-statistics":21,"../list/realtime-statistics":23,"../list/statistics":25,"./taskrouter-resource":15}],15:[function(require,module,exports){
  var Resource = require('./resource');
  /**
   * @author jwitz
   * @version 1.1.0
   *
   * @constructor
   * @param {string} token - The JWT access token
   * @param {string} resourceUrl - REST API resource url
   * @param {string} apiRequester - issues the api request
   * @param {string} workspaceUrl - REST API workspace url
   * @memberOf Twilio.TaskRouter
   * @description Creates a Twilio TaskRouter Resource which can fetch or update its attributes
   */
  function TaskRouterResource(token, resourceUrl, apiRequester, workspaceUrl) {
      Object.defineProperties(this, {
          'workspaceUrl' : {
              value: workspaceUrl
          }
      });
      Resource.call(this, token, resourceUrl, apiRequester);
  }
  TaskRouterResource.prototype = Object.create(Resource.prototype);

  module.exports = TaskRouterResource;

  },{"./resource":12}],16:[function(require,module,exports){
  var TaskRouterResource = require('./taskrouter-resource');
  var Statistics = require('../list/statistics');
  /**
   * @author jwitz
   * @version 1.1.0
   *
   * @constructor
   * @param {string} token - The JWT access token
   * @param {string} sid - the sid of the worker
   * @param {string} apiRequester - issues the api request
   * @param {string} workspaceUrl - REST API workspace url
   * @memberOf Twilio.TaskRouter
   * @description Creates a Twilio TaskRouter Worker which can fetch its attributes
   */
  function Worker(token, sid, apiRequester, workspaceUrl) {
      var resourceUrl = workspaceUrl+"/Workers/"+sid;

      var statistics = new Statistics(token, resourceUrl, apiRequester, workspaceUrl);
      Object.defineProperties(this, {
          'statistics' : {
              value: statistics,
              enumerable: true
          }
      });

      TaskRouterResource.call(this, token, resourceUrl, apiRequester, workspaceUrl);
  }
  Worker.prototype = Object.create(TaskRouterResource.prototype);

  /**
   * Update the JWT with a non-expired one
   * @param {string} token - new token
   */
  Worker.prototype.updateToken = function updateToken(token) {
      this.token = token;
      this.statistics.updateToken(token);
  };

  module.exports = Worker;

  },{"../list/statistics":25,"./taskrouter-resource":15}],17:[function(require,module,exports){
  var TaskRouterResource = require('./taskrouter-resource');
  /**
   * @author gramanathaiah
   * @version 1.6.0
   *
   * @constructor
   * @param {string} token - The JWT access token
   * @param {string} workerSid - the sid of the worker
   * @param {string} channelSid - the sid of the worker channel
   * @param {string} apiRequester - issues the api request
   * @param {string} workspaceUrl - REST API workspace url
   * @memberOf Twilio.TaskRouter
   * @description Creates a Twilio TaskRouter WorkerChannel which can fetch its attributes
   */
  function WorkerChannel(token, workerSid, channelSid, apiRequester, workspaceUrl) {
      var resourceUrl = workspaceUrl+"/Workers/"+workerSid+"/Channels/"+channelSid;
      TaskRouterResource.call(this, token, resourceUrl, apiRequester, workspaceUrl);
  }
  WorkerChannel.prototype = Object.create(TaskRouterResource.prototype);

  module.exports = WorkerChannel;


  },{"./taskrouter-resource":15}],18:[function(require,module,exports){
  var TaskRouterResource = require('./taskrouter-resource');
  var Statistics = require('../list/statistics');
  var RealTimeStatistics = require('../list/realtime-statistics');
  var CumulativeStatistics = require('../list/cumulative-statistics');
  /**
   * @author jwitz
   * @version 1.1.0
   *
   * @constructor
   * @param {string} token - The JWT access token
   * @param {string} sid - the sid of the workflow
   * @param {string} apiRequester - issues the api request
   * @param {string} workspaceUrl - REST API workspace url
   * @memberOf Twilio.TaskRouter
   * @description Creates a Twilio TaskRouter Workflow which can fetch its attributes
   */
  function Workflow(token, sid, apiRequester, workspaceUrl) {
      var resourceUrl = workspaceUrl+"/Workflows/"+sid;

      var statistics = new Statistics(token, resourceUrl, apiRequester, workspaceUrl);
      var realtimeStats = new RealTimeStatistics(token, resourceUrl, apiRequester, workspaceUrl);
      var cumulativeStats = new CumulativeStatistics(token, resourceUrl, apiRequester, workspaceUrl);

      Object.defineProperties(this, {
          'statistics' : {
              value: statistics,
              enumerable: true
          },
          'realtimeStats' : {
              value: realtimeStats,
              enumerable: true
          },
          'cumulativeStats' : {
              value: cumulativeStats,
              enumerable: true
          }
      });

      TaskRouterResource.call(this, token, resourceUrl, apiRequester, workspaceUrl);
  }
  Workflow.prototype = Object.create(TaskRouterResource.prototype);

  /**
   * Update the JWT with a non-expired one
   * @param {string} token - new token
   */
  Workflow.prototype.updateToken = function updateToken(token) {
      this.token = token;
      this.statistics.updateToken(token);
  };

  module.exports = Workflow;

  },{"../list/cumulative-statistics":21,"../list/realtime-statistics":23,"../list/statistics":25,"./taskrouter-resource":15}],19:[function(require,module,exports){
  var TaskRouterResource = require('./taskrouter-resource');
  var ActivityList = require('../list/activities');
  var WorkflowList = require('../list/workflows');
  var WorkerList = require('../list/workers');
  var TaskQueueList = require('../list/taskqueues');
  var TaskList = require('../list/tasks');
  var Statistics = require('../list/statistics');
  var RealTimeStatistics = require('../list/realtime-statistics');
  var CumulativeStatistics = require('../list/cumulative-statistics');
  /**
   * @author jwitz
   * @version 1.1.0
   *
   * @constructor
   * @param {string} token - The JWT access token
   * @param {string} apiRequester - issues the api request
   * @param {string} workspaceUrl - REST API workspace url
   * @memberOf Twilio.TaskRouter
   * @description Creates a Twilio TaskRouter Workspace which can fetch its attributes
   */
  function Workspace(token, apiRequester, workspaceUrl) {
      TaskRouterResource.call(this, token, workspaceUrl, apiRequester, workspaceUrl);

      var activityList = new ActivityList(token, apiRequester, workspaceUrl);
      var workflowList = new WorkflowList(token, apiRequester, workspaceUrl);
      var workerList = new WorkerList(token, apiRequester, workspaceUrl);
      var queueList = new TaskQueueList(token, apiRequester, workspaceUrl);
      var taskList = new TaskList(token, apiRequester, workspaceUrl);

      var statistics = new Statistics(token, workspaceUrl, apiRequester, workspaceUrl);
      var realtimeStats = new RealTimeStatistics(token, workspaceUrl, apiRequester, workspaceUrl);
      var cumulativeStats = new CumulativeStatistics(token, workspaceUrl, apiRequester, workspaceUrl);

      Object.defineProperties(this, {
          'activities': {
              value : activityList,
              enumerable: true
          },
          'workflows': {
              value : workflowList,
              enumerable: true
          },
          'taskqueues': {
              value: queueList,
              enumerable: true
          },
          'workers' : {
              value: workerList,
              enumerable: true
          },
          'tasks' : {
              value: taskList,
              enumerable: true
          },
          'statistics' : {
              value: statistics,
              enumerable: true
          },
          'realtimeStats' : {
              value: realtimeStats,
              enumerable: true
          },
          'cumulativeStats' : {
              value: cumulativeStats,
              enumerable: true
          }
      });
  }
  Workspace.prototype = Object.create(TaskRouterResource.prototype);

  /**
   * Update the JWT with a non-expired one
   * @param {string} token - new token
   */
  Workspace.prototype.updateToken = function updateToken(token) {
      this.token = token;
      this.activities.updateToken(token);
      this.workflows.updateToken(token);
      this.taskqueues.updateToken(token);
      this.workers.updateToken(token);
      this.tasks.updateToken(token);
      this.statistics.updateToken(token);
  };

  module.exports = Workspace;

  },{"../list/activities":20,"../list/cumulative-statistics":21,"../list/realtime-statistics":23,"../list/statistics":25,"../list/taskqueues":26,"../list/tasks":28,"../list/workers":30,"../list/workflows":31,"./taskrouter-resource":15}],20:[function(require,module,exports){
  var TaskRouterListResource = require('./taskrouter-list-resource');
  /**
   * @author jwitz
   * @version 1.1.0
   *
   * @constructor
   * @param {string} token - The JWT access token
   * @param {string} sid - the sid of the task
   * @param {string} apiRequester - issues the api request
   * @param {string} workspaceUrl - REST API workspace url
   * @memberOf Twilio.TaskRouter
   * @description Creates a Twilio TaskRouter ActivityList which can fetch the list of activities or create a new activity
   */
  function ActivityList(token, apiRequester, workspaceUrl) {
      var resourceUrl = workspaceUrl+"/Activities";
      TaskRouterListResource.call(this, token, resourceUrl, apiRequester, workspaceUrl);
  }
  ActivityList.prototype = Object.create(TaskRouterListResource.prototype);

  module.exports = ActivityList;

  },{"./taskrouter-list-resource":27}],21:[function(require,module,exports){
  var TaskRouterListResource = require('./taskrouter-list-resource');
  /**
   * @author jwitz
   * @version 1.1.0
   *
   * @constructor
   * @param {string} token - The JWT access token
   * @param {string} resourceUrl - REST API resource url to fetch statistics for
   * @param {string} apiRequester - issues the api request
   * @param {string} workspaceUrl - REST API workspace url
   * @memberOf Twilio.TaskRouter
   * @description CumulativeStatistics Statistics fetcher
   */
  function CumulativeStatistics(token, resourceUrl, apiRequester, workspaceUrl) {
      var statsResourceUrl = resourceUrl+"/CumulativeStatistics";
      TaskRouterListResource.call(this, token, statsResourceUrl, apiRequester, workspaceUrl);
  }
  CumulativeStatistics.prototype = Object.create(TaskRouterListResource.prototype);

  module.exports = CumulativeStatistics;

  },{"./taskrouter-list-resource":27}],22:[function(require,module,exports){
  /**
   * @author jwitz
   * @version 1.1.0
   *
   * @constructor
   * @param {string} token - The JWT access token
   * @param {string} resourceUrl - REST API list resource url
   * @param {string} apiRequester - issues the api request
   * @memberOf Twilio
   * @description Creates a Twilio List Resource which can fetch a list or create a new entity
   */
  function ListResource(token, resourceUrl, apiRequester) {
      Object.defineProperties(this, {
          'token' : {
              value: token,
              writable: true
          },
          'resourceUrl' : {
              value: resourceUrl
          },
          'apiRequester' : {
              value: apiRequester
          }
      });
  }

  /**
   * Get a resource list's information
   * @param {json or string} params - (optional) json formatted query parameters or a single SID
   * @param {function} completion - async function to run upon completion of the query
   */
  ListResource.prototype.fetch = function fetch() {
      // handle optional params argument first
      var arg0 = arguments[0];
      var arg1 = arguments[1];

      var params;
      var completion;

      if(typeof arg0 === "string") {
          // handling a single SID
          var sid = arg0;
          if(arg1 instanceof Function) {
              completion = arg1;
          }else {
              throw Error("2nd argument needs to be a function");
          }

          var sidRequest = JSON.stringify({"url": this.resourceUrl+"/"+sid, "method":"GET", "token": this.token});
          this.apiRequester._postMessage(sidRequest, completion);
      }else {
          if(arg0 instanceof Function) {
              // handle no query parameters
              completion = arg0;
          }else if(arg0 instanceof Object) {
              // handle query parameters first, then completion function as 2nd arg
              params = arg0;
              if(arg1 instanceof Function) {
                  completion = arg1;
              }else {
                  throw Error("2nd argument needs to be a function");
              }
          }else {
              throw Error("1st argument needs to be either a callback function, query parameters, or a SID string");
          }

          var request = {"url": this.resourceUrl, "method":"GET", "token": this.token};
          if(params) {
              request.params = params;
          }
          var jsonParams = JSON.stringify(request);
          this.apiRequester._postMessage(jsonParams, completion);
      }
  };

  /**
   * Create a list resource
   * @param {json} params - json formatted POST parameters
   * @param {function} completion - async function to run upon completion of the query
   */
  ListResource.prototype.create = function create(params, completion) {
      var request = JSON.stringify({"url": this.resourceUrl, "method":"POST", "params":params, "token": this.token});
      this.apiRequester._postMessage(request, completion);
  };

  /**
   * Update a resource
   * @param {string} sid - sid to update
   * @param {json} params - json formatted POST parameters or a single attribute and value
   * @param {function} completion - async function to run upon completion of the post
   */
  ListResource.prototype.update = function update() {

      // handle optional single parameters argument
      var sid = arguments[0];
      var arg1 = arguments[1];
      var arg2 = arguments[2];
      var arg3 = arguments[3];

      var params = {};
      var completion;
      if(typeof arg1 === "string") {
          // we're handling a single attribute update
          if(typeof arg2 === "string") {
              params[arg1] = arg2;
              completion = arg3;
          }else {
              throw Error("3rd argument needs to be a string value");
          }
      }else if(arg1 instanceof Object) {
          params = arg1;
          for (var key in params) {
              var value = params[key];
              if(value instanceof Object) {
                  params[key] = JSON.stringify(value);
              }
          }
          if(typeof arg2 === 'undefined' || arg2 instanceof Function) {
              completion = arg2;
          }else {
              throw Error("3rd argument needs to be a function");
          }
      }else {
          throw Error("2nd argument needs to either be a string or a JSON object");
      }
      var request = JSON.stringify({"url": this.resourceUrl+"/"+sid, "method":"POST", "params":params, "token": this.token});
      this.apiRequester._postMessage(request, completion, this);
  };

  /**
   * Delete a resource
   * @param {string} sid - the sid to delete
   * @param {function} completion - async function to run upon completion of the deletion
   */
  ListResource.prototype.delete = function deleteR(sid, completion) {
      var request = JSON.stringify({"url": this.resourceUrl+"/"+sid, "method":"DELETE", "token": this.token});
      this.apiRequester._postMessage(request, completion);
  };

  /**
   * Update the JWT with a non-expired one
   * @param {string} token - new token
   */
  ListResource.prototype.updateToken = function updateToken(token) {
      this.token = token;
  };

  module.exports = ListResource;

  },{}],23:[function(require,module,exports){
  var TaskRouterListResource = require('./taskrouter-list-resource');
  /**
   * @author jwitz
   * @version 1.1.0
   *
   * @constructor
   * @param {string} token - The JWT access token
   * @param {string} resourceUrl - REST API resource url to fetch statistics for
   * @param {string} apiRequester - issues the api request
   * @param {string} workspaceUrl - REST API workspace url
   * @memberOf Twilio.TaskRouter
   * @description RealTime Statistics fetcher
   */
  function RealTimeStatistics(token, resourceUrl, apiRequester, workspaceUrl) {
      var statsResourceUrl = resourceUrl+"/RealTimeStatistics";
      TaskRouterListResource.call(this, token, statsResourceUrl, apiRequester, workspaceUrl);
  }
  RealTimeStatistics.prototype = Object.create(TaskRouterListResource.prototype);

  module.exports = RealTimeStatistics;

  },{"./taskrouter-list-resource":27}],24:[function(require,module,exports){
  var TaskRouterListResource = require('./taskrouter-list-resource');
  /**
   * @author jwitz
   * @version 1.1.0
   *
   * @constructor
   * @param {string} token - The JWT access token
   * @param {string} url - The URL
   * @param {string} apiRequester - issues the api request
   * @param {string} workspaceUrl - REST API workspace url
   * @memberOf Twilio.TaskRouter
   * @description Creates a Twilio TaskRouter ReservationList which can fetch the list of reservations
   */
  function ReservationList(token, url, apiRequester, workspaceUrl) {
      var resourceUrl = url.split('?')[0];
      TaskRouterListResource.call(this, token, resourceUrl, apiRequester, workspaceUrl);
  }
  ReservationList.prototype = Object.create(TaskRouterListResource.prototype);

  module.exports = ReservationList;

  },{"./taskrouter-list-resource":27}],25:[function(require,module,exports){
  var TaskRouterListResource = require('./taskrouter-list-resource');
  /**
   * @author jwitz
   * @version 1.1.0
   *
   * @constructor
   * @param {string} token - The JWT access token
   * @param {string} resourceUrl - REST API resource url to fetch statistics for
   * @param {string} apiRequester - issues the api request
   * @param {string} workspaceUrl - REST API workspace url
   * @memberOf Twilio.TaskRouter
   * @description Creates a Twilio TaskRouter Activity which can fetch its attributes
   */
  function Statistics(token, resourceUrl, apiRequester, workspaceUrl) {
      var statsResourceUrl = resourceUrl+"/Statistics";
      TaskRouterListResource.call(this, token, statsResourceUrl, apiRequester, workspaceUrl);
  }
  Statistics.prototype = Object.create(TaskRouterListResource.prototype);

  module.exports = Statistics;

  },{"./taskrouter-list-resource":27}],26:[function(require,module,exports){
  var TaskRouterListResource = require('./taskrouter-list-resource');
  var Statistics = require('../list/statistics');
  var RealTimeStatistics = require('../list/realtime-statistics');
  var CumulativeStatistics = require('../list/cumulative-statistics');
  /**
   * @author jwitz
   * @version 1.1.0
   *
   * @constructor
   * @param {string} token - The JWT access token
   * @param {string} apiRequester - issues the api request
   * @param {string} workspaceUrl - REST API workspace url
   * @memberOf Twilio.TaskRouter
   * @description Creates a Twilio TaskRouter TaskQueueList which can fetch the list of queues or create a new queue
   */
  function TaskQueueList(token, apiRequester, workspaceUrl) {
      var resourceUrl = workspaceUrl+"/TaskQueues";

      var statistics = new Statistics(token, resourceUrl, apiRequester, workspaceUrl);
      var realtimeStats = new RealTimeStatistics(token, resourceUrl, apiRequester, workspaceUrl);
      var cumulativeStats = new CumulativeStatistics(token, resourceUrl, apiRequester, workspaceUrl);

      Object.defineProperties(this, {
          'statistics' : {
              value: statistics,
              enumerable: true
          },
          'realtimeStats' : {
              value: realtimeStats,
              enumerable: true
          },
          'cumulativeStats' : {
              value: cumulativeStats,
              enumerable: true
          }
      });

      TaskRouterListResource.call(this, token, resourceUrl, apiRequester, workspaceUrl);
  }
  TaskQueueList.prototype = Object.create(TaskRouterListResource.prototype);

  /**
   * Update the JWT with a non-expired one
   * @param {string} token - new token
   */
  TaskQueueList.prototype.updateToken = function updateToken(token) {
      this.token = token;
      this.statistics.updateToken(token);
  };

  module.exports = TaskQueueList;

  },{"../list/cumulative-statistics":21,"../list/realtime-statistics":23,"../list/statistics":25,"./taskrouter-list-resource":27}],27:[function(require,module,exports){
  var ListResource = require('./list-resource');
  /**
   * @author jwitz
   * @version 1.1.0
   *
   * @constructor
   * @param {string} token - The JWT access token
   * @param {string} workspaceUrl - REST API list url
   * @param {string} apiRequester - issues the api request
   * @param {string} workspaceUrl - REST API workspace url
   * @memberOf Twilio
   * @description Creates a Twilio TaskRouter List Resource which can fetch a list or create a new entity
   */
  function TaskRouterListResource(token, resourceUrl, apiRequester, workspaceUrl) {
      Object.defineProperties(this, {
          'workspaceUrl' : {
              value: workspaceUrl
          }
      });
      ListResource.call(this, token, resourceUrl, apiRequester);
  }
  TaskRouterListResource.prototype = Object.create(ListResource.prototype);

  module.exports = TaskRouterListResource;

  },{"./list-resource":22}],28:[function(require,module,exports){
  var TaskRouterListResource = require('./taskrouter-list-resource');
  /**
   * @author jwitz
   * @version 1.1.0
   *
   * @constructor
   * @param {string} token - The JWT access token
   * @param {string} apiRequester - issues the api request
   * @param {string} workspaceUrl - REST API workspace url
   * @memberOf Twilio.TaskRouter
   * @description Creates a Twilio TaskRouter TaskList which can fetch the list of tasks or create a new task
   */
  function TaskList(token, apiRequester, workspaceUrl) {
      var resourceUrl = workspaceUrl+"/Tasks";
      TaskRouterListResource.call(this, token, resourceUrl, apiRequester, workspaceUrl);
  }
  TaskList.prototype = Object.create(TaskRouterListResource.prototype);

  module.exports = TaskList;

  },{"./taskrouter-list-resource":27}],29:[function(require,module,exports){
  var TaskRouterListResource = require('./taskrouter-list-resource');
  /**
   * @author  gramanathaiah
   * @version 1.1.0
   *
   * @constructor
   * @param {string} token - The JWT access token
   * @param {string} apiRequester - issues the api request
   * @param {string} workspaceUrl - REST API workspace url
   * @memberOf Twilio.TaskRouter
   * @description Creates a Twilio TaskRouter WorkerChannel List  which can fetch the list of Channels
   */
  function WorkerChannelList(token, url ,apiRequester, workspaceUrl) {
      var resourceUrl = url.split('?')[0];
      TaskRouterListResource.call(this, token, resourceUrl, apiRequester, workspaceUrl);
  }
  WorkerChannelList.prototype = Object.create(TaskRouterListResource.prototype);

  module.exports = WorkerChannelList;

  },{"./taskrouter-list-resource":27}],30:[function(require,module,exports){
  var TaskRouterListResource = require('./taskrouter-list-resource');
  var Statistics = require('../list/statistics');
  var RealTimeStatistics = require('../list/realtime-statistics');
  var CumulativeStatistics = require('../list/cumulative-statistics');
  /**
   * @author jwitz
   * @version 1.1.0
   *
   * @constructor
   * @param {string} token - The JWT access token
   * @param {string} apiRequester - issues the api request
   * @param {string} workspaceUrl - REST API workspace url
   * @memberOf Twilio.TaskRouter
   * @description Creates a Twilio TaskRouter WorkerList which can fetch the list of workers or create a new worker
   */
  function WorkerList(token, apiRequester, workspaceUrl) {
      var resourceUrl = workspaceUrl+"/Workers";

      var statistics = new Statistics(token, resourceUrl, apiRequester, workspaceUrl);
      var realtimeStats = new RealTimeStatistics(token, resourceUrl, apiRequester, workspaceUrl);
      var cumulativeStats = new CumulativeStatistics(token, resourceUrl, apiRequester, workspaceUrl);

      Object.defineProperties(this, {
          'statistics' : {
              value: statistics,
              enumerable: true
          },
          'realtimeStats' : {
              value: realtimeStats,
              enumerable: true
          },
          'cumulativeStats' : {
              value: cumulativeStats,
              enumerable: true
          }
      });

      TaskRouterListResource.call(this, token, resourceUrl, apiRequester, workspaceUrl);
  }
  WorkerList.prototype = Object.create(TaskRouterListResource.prototype);

  /**
   * Update the JWT with a non-expired one
   * @param {string} token - new token
   */
  WorkerList.prototype.updateToken = function updateToken(token) {
      this.token = token;
      this.statistics.updateToken(token);
  };

  module.exports = WorkerList;

  },{"../list/cumulative-statistics":21,"../list/realtime-statistics":23,"../list/statistics":25,"./taskrouter-list-resource":27}],31:[function(require,module,exports){
  var TaskRouterListResource = require('./taskrouter-list-resource');
  /**
   * @author jwitz
   * @version 1.1.0
   *
   * @constructor
   * @param {string} token - The JWT access token
   * @param {string} apiRequester - issues the api request
   * @param {string} workspaceUrl - REST API workspace url
   * @memberOf Twilio.TaskRouter
   * @description Creates a Twilio TaskRouter WorkflowList which can fetch the list of workflows or create a new workflow
   */
  function WorkflowList(token, apiRequester, workspaceUrl) {
      var resourceUrl = workspaceUrl+"/Workflows";
      TaskRouterListResource.call(this, token, resourceUrl, apiRequester, workspaceUrl);
  }
  WorkflowList.prototype = Object.create(TaskRouterListResource.prototype);

  module.exports = WorkflowList;

  },{"./taskrouter-list-resource":27}],32:[function(require,module,exports){
  /**
   * @author jwitz
   * @version 1.1.0
   *
   * Converting a snake-case property to a camelcase property
   *
   * @name convertToCamelCase
   * @exports convertToCamelCase as Twilio.convertToCamelCase
   * @memberOf Twilio
   * @param {string} snakeCaseProperty json snake case property
   * @return {object} camelCaseProperty
   */
  function convertToCamelCase(snakeCaseProperty) {
      var underScoreIndex = snakeCaseProperty.indexOf("_");
      if(underScoreIndex === -1) {
          return snakeCaseProperty;
      }else {
          var firstProperty = snakeCaseProperty.substring(0, underScoreIndex);
          var startOfNextChar = snakeCaseProperty.charAt(underScoreIndex+1).toUpperCase();
          var restOfProperties = snakeCaseProperty.substring(underScoreIndex+2, snakeCaseProperty.length);
          var newProperty = firstProperty + startOfNextChar + restOfProperties;
          return convertToCamelCase(newProperty);
      }
  }

  exports.convertToCamelCase = convertToCamelCase;

  },{}],33:[function(require,module,exports){
  var Workspace = require('../resources/instance/workspace');
  var Activity = require('../resources/instance/activity');
  var Workflow = require('../resources/instance/workflow');
  var TaskQueue = require('../resources/instance/taskqueue');
  var Worker = require('../resources/instance/worker');
  var Task = require('../resources/instance/task');
  var Reservation = require('../resources/instance/reservation');
  var WorkerChannel = require('../resources/instance/workerchannel');

  var ActivityList = require('../resources/list/activities');
  var WorkflowList = require('../resources/list/workflows');
  var TaskQueueList = require('../resources/list/taskqueues');
  var WorkerList = require('../resources/list/workers');
  var TaskList = require('../resources/list/tasks');
  var ReservationList = require('../resources/list/reservations');
  var WorkerChannelList = require('../resources/list/workerchannels');

  var PropertyUtil = require('./property');

  /**
   * @author jwitz
   * @version 1.1.0
   *
   * Define objects for foreign key lookups
   *
   * @name setFKLookup
   * @exports setFKLookup as Twilio.TaskRouter.setFKLookup
   * @memberOf Twilio.TaskRouter
   * @function
   * @param {object} object object to set properties on
   * @param {string} sidType sid type
   * @param {string} sid sid
   * @param {string} token token to run rest api request on
   * @param {string} apiRequester utility to run api requests
   * @param {string} workspaceUrl workspace uri
   */
  function setFKLookup(object, sidType, sid, token, apiRequester, workspaceUrl) {
      var fkObject;
      var type;

      if(sidType === 'workspaceSid') {
          fkObject = new Workspace(token, apiRequester, workspaceUrl);
          type = 'workspace';
      }else if(sidType === 'workflowSid') {
          fkObject = new Workflow(token, sid, apiRequester, workspaceUrl);
          type = 'workflow';
      }else if(sidType === 'queueSid') {
          fkObject = new TaskQueue(token, sid, apiRequester, workspaceUrl);
          type = 'queue';
      }else if(sidType === 'workerSid') {
          fkObject = new Worker(token, sid, apiRequester, workspaceUrl);
          type = 'worker';
      }else if(sidType.toLowerCase().indexOf('activitysid') > 0) {
          fkObject = new Activity(token, sid, apiRequester, workspaceUrl);
          type = sidType.substring(0, sidType.indexOf("Sid"));
      }else if(sidType === 'taskSid') {
          fkObject = new Task(token, sid, apiRequester, workspaceUrl);
          type = 'task';
      }else if(sidType === 'reservationSid') {
          fkObject = new Reservation(token, sid, apiRequester, workspaceUrl);
          type = 'reservation';
      }

      if(typeof fkObject !== 'undefined') {
          if(!object.hasOwnProperty(type)) {
              Object.defineProperty(object, type, {
                  enumerable: true,
                  value: fkObject
              });
          }
      }
  }

  /**
   * Create an entity for a payload based on the sid
   *
   * @name createEntity
   * @exports createEntity as Twilio.TaskRouter.createEntity
   * @memberOf Twilio.TaskRouter
   * @function
   * @param payload for the entity
   * @param {object} payload json properties to set on new object
   * @param {string} token token to run rest api request on
   * @param {string} apiRequester utility to run api requests
   * @param {string} workspaceURL the workspace to use
   * @returns {*} an entity for the given object
   */
  function createEntity(payload, token, apiRequester, workspaceUrl) {
      if(!payload) {
          return;
      }

      var entity;
      if(payload.sid) {
          var sid = payload.sid;
          var prefix = sid.substring(0, 2);

          if(prefix === 'WS') {
              entity = new Workspace(token, apiRequester, workspaceUrl);
          }else if(prefix === 'WW') {
              entity = new Workflow(token, sid, apiRequester, workspaceUrl);
          }else if(prefix === 'WQ') {
              entity = new TaskQueue(token, sid, apiRequester, workspaceUrl);
          }else if(prefix === 'WK') {
              entity = new Worker(token, sid, apiRequester, workspaceUrl);
          }else if(prefix === 'WA') {
              entity = new Activity(token, sid, apiRequester, workspaceUrl);
          }else if(prefix === 'WT') {
              entity = new Task(token, sid, apiRequester, workspaceUrl);
          }else if(prefix === 'WR') {
              var taskSid = payload.task_sid;
              entity = new Reservation(token, sid, taskSid, apiRequester, workspaceUrl);
          }else if(prefix === 'WC') {
              var workerSid = payload.worker_sid;
              entity = new WorkerChannel(token, workerSid, sid, apiRequester, workspaceUrl);
          }
          PropertyUtil.setProperties(entity, payload, token, apiRequester, workspaceUrl);
          return entity;

      }else if(payload.meta) {
          var meta = payload.meta;
          var metaKey = payload.meta.key;

          if(metaKey.indexOf("statistics") === -1) {

              // list entities so we can create and fetch next/previous pages
              var listEntity;
              if(metaKey === 'workflows') {
                  listEntity = new WorkflowList(token, apiRequester, workspaceUrl);
              }else if(metaKey === 'task_queues') {
                  listEntity = new TaskQueueList(token, apiRequester, workspaceUrl);
              }else if(metaKey === 'workers') {
                  listEntity = new WorkerList(token, apiRequester, workspaceUrl);
              }else if(metaKey === 'activities') {
                  listEntity = new ActivityList(token, apiRequester, workspaceUrl);
              }else if(metaKey === 'tasks') {
                  listEntity = new TaskList(token, apiRequester, workspaceUrl);
              }else if(metaKey === 'reservations') {
                  listEntity = new ReservationList(token, meta.url, apiRequester, workspaceUrl);
              }else if(metaKey === 'channels') {
                  listEntity = new WorkerChannelList(token, meta.url, apiRequester, workspaceUrl);
              }

              // list items
              var listItems = [];
              payload[metaKey].forEach(function(element) {
                  var listItem;
                  if(metaKey === 'workflows') {
                      listItem = new Workflow(token, element.sid, apiRequester, workspaceUrl);
                  }else if(metaKey === 'task_queues') {
                      listItem = new TaskQueue(token, element.sid, apiRequester, workspaceUrl);
                  }else if(metaKey === 'workers') {
                      listItem = new Worker(token, element.sid, apiRequester, workspaceUrl);
                  }else if(metaKey === 'activities') {
                      listItem = new Activity(token, element.sid, apiRequester, workspaceUrl);
                  }else if(metaKey === 'tasks') {
                      listItem = new Task(token, element.sid, apiRequester, workspaceUrl);
                  }else if(metaKey === 'reservations') {
                      var taskSid = element.task_sid;
                      listItem = new Reservation(token, element.sid, taskSid, apiRequester, workspaceUrl);
                  }else if(metaKey === 'channels' ) {
                      var workerSid = element.worker_sid;
                      listItem  = new WorkerChannel(token, workerSid, element.sid, apiRequester, workspaceUrl);
                  }
                  if(listItem) {
                      PropertyUtil.setProperties(listItem, element, token, apiRequester, workspaceUrl);
                      listItems.push(listItem);
                  }
              });

              Object.defineProperty(listEntity, 'data', {
                  enumerable: true,
                  value: listItems
              });

              Object.defineProperty(listEntity, 'page', {
                  enumerable: true,
                  value: meta.page
              });

              Object.defineProperty(listEntity, 'pageSize', {
                  enumerable: true,
                  value: meta.page_size
              });

              if(meta.next_page_url) {
                  Object.defineProperty(listEntity, 'next', {
                      value: function (completion) {
                          var request = {"url": meta.next_page_url, "method":"GET", "token": token};
                          var jsonParams = JSON.stringify(request);
                          this.apiRequester._postMessage(jsonParams, completion);
                      },
                      enumerable: true
                  });
                  Object.defineProperty(listEntity, 'hasNext', {
                      value: true,
                      enumerable: true
                  });
              }else {
                  Object.defineProperty(listEntity, 'hasNext', {
                      value: false,
                      enumerable: true
                  });
              }

              if(meta.previous_page_url) {
                  Object.defineProperty(listEntity, 'previous', {
                      value: function (completion) {
                          var request = {"url": meta.previous_page_url, "method":"GET", "token": token};
                          var jsonParams = JSON.stringify(request);
                          this.apiRequester._postMessage(jsonParams, completion);
                      },
                      enumerable: true
                  });
                  Object.defineProperty(listEntity, 'hasPrevious', {
                      value: true,
                      enumerable: true
                  });
              }else {
                  Object.defineProperty(listEntity, 'hasPrevious', {
                      value: false,
                      enumerable: true
                  });
              }

              return listEntity;

          }else {
              // dealing with statistics for a list resource
              var statsList = {};
              var statsListJSON = payload[metaKey];
              PropertyUtil.setProperties(statsList, statsListJSON);
              return statsList;
          }
      }else if(payload.cumulative || payload.realtime || (payload.url && payload.url.indexOf("Statistics") !== -1)) {
          // dealing with statistics for a particular Sid
          var stats = {};
          var statsJSON = payload;
          PropertyUtil.setProperties(stats, statsJSON);
          return stats;
      }
  }

  exports.setFKLookup = setFKLookup;
  exports.createEntity = createEntity;

  },{"../resources/instance/activity":10,"../resources/instance/reservation":11,"../resources/instance/task":13,"../resources/instance/taskqueue":14,"../resources/instance/worker":16,"../resources/instance/workerchannel":17,"../resources/instance/workflow":18,"../resources/instance/workspace":19,"../resources/list/activities":20,"../resources/list/reservations":24,"../resources/list/taskqueues":26,"../resources/list/tasks":28,"../resources/list/workerchannels":29,"../resources/list/workers":30,"../resources/list/workflows":31,"./property":35}],34:[function(require,module,exports){
  (function (Buffer){
  function memoize(fn) {
      return function() {
          var args = Array.prototype.slice.call(arguments, 0);
          fn.memo = fn.memo || {};
          return fn.memo[args] ? fn.memo[args] : fn.memo[args] = fn.apply(null, args);
      };
  }

  function decodePayload(encoded_payload) {
      var remainder = encoded_payload.length % 4;
      if (remainder > 0) {
          var padlen = 4 - remainder;
          encoded_payload += new Array(padlen + 1).join("=");
      }
      encoded_payload = encoded_payload.replace(/-/g, "+")
                                       .replace(/_/g, "/");
      var decoded_payload = _atob(encoded_payload);
      return JSON.parse(decoded_payload);
  }

  var memoizedDecodePayload = memoize(decodePayload);

  /**
   * Decodes a token.
   *
   * @name decode
   * @exports decode as Twilio.decode
   * @memberOf Twilio
   * @function
   * @param {string} token The JWT
   * @return {object} The payload
   */
  function decode(token) {
      var segs = token.split(".");
      if (segs.length != 3) {
          throw new Error("Wrong number of segments");
      }
      var encoded_payload = segs[1];
      var payload = memoizedDecodePayload(encoded_payload);
      return payload;
  }

  /**
   * Wrapper for atob.
   *
   * @name atob
   * @exports _atob as Twilio.atob
   * @memberOf Twilio
   * @function
   * @param {string} encoded The encoded string
   * @return {string} The decoded string
   */
  function _atob(encoded) {
      try {
          return atob(encoded);
      } catch (e) {
          try {
              return new Buffer(encoded, "base64").toString("ascii");
          } catch (f) {
              return Twilio._phpjs_atob(encoded);
          }
      }
  }

  function objectize(token) {
      var jwt = decode(token);
      return jwt;
  }

  var memoizedObjectize = memoize(objectize);

  exports.decode = decode;
  exports.atob = _atob;
  exports.objectize = memoizedObjectize;

  }).call(this,require("buffer").Buffer)
  },{"buffer":37}],35:[function(require,module,exports){
  var CamelCaseUtil = require('./camelcase');
  var EntityUtil = require('./entity');
  /**
   * @author jwitz
   * @version 1.1.0
   *
   * Loop through payload properties (json) and set them on an object
   * Additionally, create FK objects as needed to create additional object fetches
   * and handle payload properties (json) with multiple layers of depth
   *
   * @name setProperties
   * @exports convertToCamelCase as Twilio.convertToCamelCase
   * @memberOf Twilio
   * @function
   * @param {object} object object to set properties on
   * @param {string} payload json payload
   * @return {object} camelCaseProperty
   */
  function setProperties(object, payload, token, apiRequester, workspaceUrl) {
      for (var property in payload) {
          if(property == 'reservation_sid' || property === 'url' || property === 'links') {
              continue;
          }

          var propertyValue;
          if(property === 'attributes' || property === 'configuration' || property === 'addons') {
              propertyValue = JSON.parse(payload[property]);
          }else if(property === 'date_created' || property === 'date_updated' || property === 'date_status_changed') {
              propertyValue = (typeof payload[property] === 'number') ? new Date(payload[property] * 1000) : new Date(payload[property]);
          }else if(payload[property] instanceof Object) {

              //handling nested properties
              propertyValue = payload[property];

              for(var prop in propertyValue) {
                  if(propertyValue.hasOwnProperty(prop)){
                      // define a new property that is camelcase
                      var propertyValueProp = propertyValue[prop];
                      var newProp = CamelCaseUtil.convertToCamelCase(prop);

                      // delete the current property that is non-camelcase
                      delete propertyValue[prop];

                      // if the nested property is an object, recursively create a new object
                      // with the object's payload to create a new object with camelcase properties
                      // otherwise just set the properties of the nested property
                      if(propertyValueProp instanceof Array) {
                          /* jshint ignore:start */
                          var arrayList = [];
                          propertyValueProp.forEach(function(element) {
                              var arrayObject = {};
                              setProperties(arrayObject, element, token, apiRequester, workspaceUrl);
                              arrayList.push(arrayObject);
                          });

                          Object.defineProperty(propertyValue, newProp, {
                              enumerable: true,
                              value: arrayList
                          });
                          /* jshint ignore:end */
                      }else if(propertyValueProp instanceof Object) {
                          var newNestedObject = {};
                          setProperties(newNestedObject, propertyValueProp, token, apiRequester, workspaceUrl);

                          Object.defineProperty(propertyValue, newProp, {
                              enumerable: true,
                              value: newNestedObject
                          });
                      }else {
                          Object.defineProperty(propertyValue, newProp, {
                              enumerable: true,
                              value: propertyValueProp
                          });
                      }

                  }
              }
          }else {
              propertyValue = payload[property];
          }

          // convert property to a camelcase version
          property = CamelCaseUtil.convertToCamelCase(property);

          // set the property on the object with the value determined above
          // override attributes on an entity update
          Object.defineProperty(object, property, {
              enumerable: true,
              configurable: true,
              value: propertyValue
          });

          // create links to other FK objects
          // (i.e. if we find queue_sid, convert to camelcase to be queueSid,
          // create a queue object within FKLookup so we can do will queue.fetch to get the full attributes)
          if(property.indexOf('Sid') > 0) {
              EntityUtil.setFKLookup(object, property, propertyValue, token, apiRequester, workspaceUrl);
          }
      }
  }

  /**
   * Sets properties on a reservation based on XHR requests to fetch a task and reservation
   * @param reservation
   * @returns {Promise}
   */
  function setReservationProperties(reservation) {
      return new Promise(function(resolve, reject) {
          var taskPromise = _getTask(reservation);
          var reservationPromise = _getReservation(reservation);

          var promises = [taskPromise, reservationPromise];
          Promise.all(promises).then(function (results) {
              var reservation = results[1];

              // set a task property on the reservation
              Object.defineProperties(reservation, {
                  'task': {
                      value: results[0],
                      enumerable: true
                  }
              });

              resolve(reservation);
          }, function(err) {
              reject(Error("Could not fetch task and reservation information"));
          });
      });
  }

  /**
   * Sets a task property on a reservation
   * @param reservation
   * @returns {Promise}
   */
  function setTaskProperty(reservation) {
      return new Promise(function(resolve, reject) {
          var taskPromise = _getTask(reservation);
          taskPromise.then(function(task) {
              // set a task property on the reservation
              Object.defineProperties(reservation, {
                  'task': {
                      value: task,
                      enumerable: true
                  }
              });
              resolve(reservation);
          });
      });
  }

  /**
   * Fetches a task
   * @param reservation a reservation for a task
   * @returns {Promise}
   * @private
   */
  function _getTask(reservation) {
      return new Promise(function (resolve, reject) {
          reservation.task.fetch(
              function (error, task) {
                  if (error) {
                      console.log(error.code);
                      console.log(error.message);
                      reject(Error(error.message));
                      return;
                  }
                  resolve(task);
              }
          );
      });
  }

  /**
   * Fetches a reservation
   * @param reservation reservation
   * @returns {Promise}
   * @private
   */
  function _getReservation(reservation) {
      return new Promise(function (resolve, reject) {
          reservation.fetch(
              function (error, reservation) {
                  if (error) {
                      console.log(error.code);
                      console.log(error.message);
                      reject(Error(error.message));
                      return;
                  }
                  resolve(reservation);
              }
          );
      });
  }

  exports.setProperties = setProperties;
  exports.setReservationProperties = setReservationProperties;
  exports.setTaskProperty = setTaskProperty;

  },{"./camelcase":32,"./entity":33}],36:[function(require,module,exports){
  var lookup = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  ;(function (exports) {
    'use strict';

    var Arr = (typeof Uint8Array !== 'undefined')
      ? Uint8Array
      : Array

    var PLUS   = '+'.charCodeAt(0)
    var SLASH  = '/'.charCodeAt(0)
    var NUMBER = '0'.charCodeAt(0)
    var LOWER  = 'a'.charCodeAt(0)
    var UPPER  = 'A'.charCodeAt(0)
    var PLUS_URL_SAFE = '-'.charCodeAt(0)
    var SLASH_URL_SAFE = '_'.charCodeAt(0)

    function decode (elt) {
      var code = elt.charCodeAt(0)
      if (code === PLUS ||
          code === PLUS_URL_SAFE)
        return 62 // '+'
      if (code === SLASH ||
          code === SLASH_URL_SAFE)
        return 63 // '/'
      if (code < NUMBER)
        return -1 //no match
      if (code < NUMBER + 10)
        return code - NUMBER + 26 + 26
      if (code < UPPER + 26)
        return code - UPPER
      if (code < LOWER + 26)
        return code - LOWER + 26
    }

    function b64ToByteArray (b64) {
      var i, j, l, tmp, placeHolders, arr

      if (b64.length % 4 > 0) {
        throw new Error('Invalid string. Length must be a multiple of 4')
      }

      // the number of equal signs (place holders)
      // if there are two placeholders, than the two characters before it
      // represent one byte
      // if there is only one, then the three characters before it represent 2 bytes
      // this is just a cheap hack to not do indexOf twice
      var len = b64.length
      placeHolders = '=' === b64.charAt(len - 2) ? 2 : '=' === b64.charAt(len - 1) ? 1 : 0

      // base64 is 4/3 + up to two characters of the original data
      arr = new Arr(b64.length * 3 / 4 - placeHolders)

      // if there are placeholders, only get up to the last complete 4 chars
      l = placeHolders > 0 ? b64.length - 4 : b64.length

      var L = 0

      function push (v) {
        arr[L++] = v
      }

      for (i = 0, j = 0; i < l; i += 4, j += 3) {
        tmp = (decode(b64.charAt(i)) << 18) | (decode(b64.charAt(i + 1)) << 12) | (decode(b64.charAt(i + 2)) << 6) | decode(b64.charAt(i + 3))
        push((tmp & 0xFF0000) >> 16)
        push((tmp & 0xFF00) >> 8)
        push(tmp & 0xFF)
      }

      if (placeHolders === 2) {
        tmp = (decode(b64.charAt(i)) << 2) | (decode(b64.charAt(i + 1)) >> 4)
        push(tmp & 0xFF)
      } else if (placeHolders === 1) {
        tmp = (decode(b64.charAt(i)) << 10) | (decode(b64.charAt(i + 1)) << 4) | (decode(b64.charAt(i + 2)) >> 2)
        push((tmp >> 8) & 0xFF)
        push(tmp & 0xFF)
      }

      return arr
    }

    function uint8ToBase64 (uint8) {
      var i,
        extraBytes = uint8.length % 3, // if we have 1 byte left, pad 2 bytes
        output = "",
        temp, length

      function encode (num) {
        return lookup.charAt(num)
      }

      function tripletToBase64 (num) {
        return encode(num >> 18 & 0x3F) + encode(num >> 12 & 0x3F) + encode(num >> 6 & 0x3F) + encode(num & 0x3F)
      }

      // go through the array every three bytes, we'll deal with trailing stuff later
      for (i = 0, length = uint8.length - extraBytes; i < length; i += 3) {
        temp = (uint8[i] << 16) + (uint8[i + 1] << 8) + (uint8[i + 2])
        output += tripletToBase64(temp)
      }

      // pad the end with zeros, but make sure to not forget the extra bytes
      switch (extraBytes) {
        case 1:
          temp = uint8[uint8.length - 1]
          output += encode(temp >> 2)
          output += encode((temp << 4) & 0x3F)
          output += '=='
          break
        case 2:
          temp = (uint8[uint8.length - 2] << 8) + (uint8[uint8.length - 1])
          output += encode(temp >> 10)
          output += encode((temp >> 4) & 0x3F)
          output += encode((temp << 2) & 0x3F)
          output += '='
          break
      }

      return output
    }

    exports.toByteArray = b64ToByteArray
    exports.fromByteArray = uint8ToBase64
  }(typeof exports === 'undefined' ? (this.base64js = {}) : exports))

  },{}],37:[function(require,module,exports){
  (function (global){
  /*!
   * The buffer module from node.js, for the browser.
   *
   * @author   Feross Aboukhadijeh <feross@feross.org> <http://feross.org>
   * @license  MIT
   */
  /* eslint-disable no-proto */

  'use strict'

  var base64 = require('base64-js')
  var ieee754 = require('ieee754')
  var isArray = require('isarray')

  exports.Buffer = Buffer
  exports.SlowBuffer = SlowBuffer
  exports.INSPECT_MAX_BYTES = 50
  Buffer.poolSize = 8192 // not used by this implementation

  var rootParent = {}

  /**
   * If `Buffer.TYPED_ARRAY_SUPPORT`:
   *   === true    Use Uint8Array implementation (fastest)
   *   === false   Use Object implementation (most compatible, even IE6)
   *
   * Browsers that support typed arrays are IE 10+, Firefox 4+, Chrome 7+, Safari 5.1+,
   * Opera 11.6+, iOS 4.2+.
   *
   * Due to various browser bugs, sometimes the Object implementation will be used even
   * when the browser supports typed arrays.
   *
   * Note:
   *
   *   - Firefox 4-29 lacks support for adding new properties to `Uint8Array` instances,
   *     See: https://bugzilla.mozilla.org/show_bug.cgi?id=695438.
   *
   *   - Safari 5-7 lacks support for changing the `Object.prototype.constructor` property
   *     on objects.
   *
   *   - Chrome 9-10 is missing the `TypedArray.prototype.subarray` function.
   *
   *   - IE10 has a broken `TypedArray.prototype.subarray` function which returns arrays of
   *     incorrect length in some situations.

   * We detect these buggy browsers and set `Buffer.TYPED_ARRAY_SUPPORT` to `false` so they
   * get the Object implementation, which is slower but behaves correctly.
   */
  Buffer.TYPED_ARRAY_SUPPORT = global.TYPED_ARRAY_SUPPORT !== undefined
    ? global.TYPED_ARRAY_SUPPORT
    : typedArraySupport()

  function typedArraySupport () {
    function Bar () {}
    try {
      var arr = new Uint8Array(1)
      arr.foo = function () { return 42 }
      arr.constructor = Bar
      return arr.foo() === 42 && // typed array instances can be augmented
          arr.constructor === Bar && // constructor can be set
          typeof arr.subarray === 'function' && // chrome 9-10 lack `subarray`
          arr.subarray(1, 1).byteLength === 0 // ie10 has broken `subarray`
    } catch (e) {
      return false
    }
  }

  function kMaxLength () {
    return Buffer.TYPED_ARRAY_SUPPORT
      ? 0x7fffffff
      : 0x3fffffff
  }

  /**
   * Class: Buffer
   * =============
   *
   * The Buffer constructor returns instances of `Uint8Array` that are augmented
   * with function properties for all the node `Buffer` API functions. We use
   * `Uint8Array` so that square bracket notation works as expected -- it returns
   * a single octet.
   *
   * By augmenting the instances, we can avoid modifying the `Uint8Array`
   * prototype.
   */
  function Buffer (arg) {
    if (!(this instanceof Buffer)) {
      // Avoid going through an ArgumentsAdaptorTrampoline in the common case.
      if (arguments.length > 1) return new Buffer(arg, arguments[1])
      return new Buffer(arg)
    }

    if (!Buffer.TYPED_ARRAY_SUPPORT) {
      this.length = 0
      this.parent = undefined
    }

    // Common case.
    if (typeof arg === 'number') {
      return fromNumber(this, arg)
    }

    // Slightly less common case.
    if (typeof arg === 'string') {
      return fromString(this, arg, arguments.length > 1 ? arguments[1] : 'utf8')
    }

    // Unusual.
    return fromObject(this, arg)
  }

  function fromNumber (that, length) {
    that = allocate(that, length < 0 ? 0 : checked(length) | 0)
    if (!Buffer.TYPED_ARRAY_SUPPORT) {
      for (var i = 0; i < length; i++) {
        that[i] = 0
      }
    }
    return that
  }

  function fromString (that, string, encoding) {
    if (typeof encoding !== 'string' || encoding === '') encoding = 'utf8'

    // Assumption: byteLength() return value is always < kMaxLength.
    var length = byteLength(string, encoding) | 0
    that = allocate(that, length)

    that.write(string, encoding)
    return that
  }

  function fromObject (that, object) {
    if (Buffer.isBuffer(object)) return fromBuffer(that, object)

    if (isArray(object)) return fromArray(that, object)

    if (object == null) {
      throw new TypeError('must start with number, buffer, array or string')
    }

    if (typeof ArrayBuffer !== 'undefined') {
      if (object.buffer instanceof ArrayBuffer) {
        return fromTypedArray(that, object)
      }
      if (object instanceof ArrayBuffer) {
        return fromArrayBuffer(that, object)
      }
    }

    if (object.length) return fromArrayLike(that, object)

    return fromJsonObject(that, object)
  }

  function fromBuffer (that, buffer) {
    var length = checked(buffer.length) | 0
    that = allocate(that, length)
    buffer.copy(that, 0, 0, length)
    return that
  }

  function fromArray (that, array) {
    var length = checked(array.length) | 0
    that = allocate(that, length)
    for (var i = 0; i < length; i += 1) {
      that[i] = array[i] & 255
    }
    return that
  }

  // Duplicate of fromArray() to keep fromArray() monomorphic.
  function fromTypedArray (that, array) {
    var length = checked(array.length) | 0
    that = allocate(that, length)
    // Truncating the elements is probably not what people expect from typed
    // arrays with BYTES_PER_ELEMENT > 1 but it's compatible with the behavior
    // of the old Buffer constructor.
    for (var i = 0; i < length; i += 1) {
      that[i] = array[i] & 255
    }
    return that
  }

  function fromArrayBuffer (that, array) {
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      // Return an augmented `Uint8Array` instance, for best performance
      array.byteLength
      that = Buffer._augment(new Uint8Array(array))
    } else {
      // Fallback: Return an object instance of the Buffer class
      that = fromTypedArray(that, new Uint8Array(array))
    }
    return that
  }

  function fromArrayLike (that, array) {
    var length = checked(array.length) | 0
    that = allocate(that, length)
    for (var i = 0; i < length; i += 1) {
      that[i] = array[i] & 255
    }
    return that
  }

  // Deserialize { type: 'Buffer', data: [1,2,3,...] } into a Buffer object.
  // Returns a zero-length buffer for inputs that don't conform to the spec.
  function fromJsonObject (that, object) {
    var array
    var length = 0

    if (object.type === 'Buffer' && isArray(object.data)) {
      array = object.data
      length = checked(array.length) | 0
    }
    that = allocate(that, length)

    for (var i = 0; i < length; i += 1) {
      that[i] = array[i] & 255
    }
    return that
  }

  if (Buffer.TYPED_ARRAY_SUPPORT) {
    Buffer.prototype.__proto__ = Uint8Array.prototype
    Buffer.__proto__ = Uint8Array
  } else {
    // pre-set for values that may exist in the future
    Buffer.prototype.length = undefined
    Buffer.prototype.parent = undefined
  }

  function allocate (that, length) {
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      // Return an augmented `Uint8Array` instance, for best performance
      that = Buffer._augment(new Uint8Array(length))
      that.__proto__ = Buffer.prototype
    } else {
      // Fallback: Return an object instance of the Buffer class
      that.length = length
      that._isBuffer = true
    }

    var fromPool = length !== 0 && length <= Buffer.poolSize >>> 1
    if (fromPool) that.parent = rootParent

    return that
  }

  function checked (length) {
    // Note: cannot use `length < kMaxLength` here because that fails when
    // length is NaN (which is otherwise coerced to zero.)
    if (length >= kMaxLength()) {
      throw new RangeError('Attempt to allocate Buffer larger than maximum ' +
                           'size: 0x' + kMaxLength().toString(16) + ' bytes')
    }
    return length | 0
  }

  function SlowBuffer (subject, encoding) {
    if (!(this instanceof SlowBuffer)) return new SlowBuffer(subject, encoding)

    var buf = new Buffer(subject, encoding)
    delete buf.parent
    return buf
  }

  Buffer.isBuffer = function isBuffer (b) {
    return !!(b != null && b._isBuffer)
  }

  Buffer.compare = function compare (a, b) {
    if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
      throw new TypeError('Arguments must be Buffers')
    }

    if (a === b) return 0

    var x = a.length
    var y = b.length

    var i = 0
    var len = Math.min(x, y)
    while (i < len) {
      if (a[i] !== b[i]) break

      ++i
    }

    if (i !== len) {
      x = a[i]
      y = b[i]
    }

    if (x < y) return -1
    if (y < x) return 1
    return 0
  }

  Buffer.isEncoding = function isEncoding (encoding) {
    switch (String(encoding).toLowerCase()) {
      case 'hex':
      case 'utf8':
      case 'utf-8':
      case 'ascii':
      case 'binary':
      case 'base64':
      case 'raw':
      case 'ucs2':
      case 'ucs-2':
      case 'utf16le':
      case 'utf-16le':
        return true
      default:
        return false
    }
  }

  Buffer.concat = function concat (list, length) {
    if (!isArray(list)) throw new TypeError('list argument must be an Array of Buffers.')

    if (list.length === 0) {
      return new Buffer(0)
    }

    var i
    if (length === undefined) {
      length = 0
      for (i = 0; i < list.length; i++) {
        length += list[i].length
      }
    }

    var buf = new Buffer(length)
    var pos = 0
    for (i = 0; i < list.length; i++) {
      var item = list[i]
      item.copy(buf, pos)
      pos += item.length
    }
    return buf
  }

  function byteLength (string, encoding) {
    if (typeof string !== 'string') string = '' + string

    var len = string.length
    if (len === 0) return 0

    // Use a for loop to avoid recursion
    var loweredCase = false
    for (;;) {
      switch (encoding) {
        case 'ascii':
        case 'binary':
        // Deprecated
        case 'raw':
        case 'raws':
          return len
        case 'utf8':
        case 'utf-8':
          return utf8ToBytes(string).length
        case 'ucs2':
        case 'ucs-2':
        case 'utf16le':
        case 'utf-16le':
          return len * 2
        case 'hex':
          return len >>> 1
        case 'base64':
          return base64ToBytes(string).length
        default:
          if (loweredCase) return utf8ToBytes(string).length // assume utf8
          encoding = ('' + encoding).toLowerCase()
          loweredCase = true
      }
    }
  }
  Buffer.byteLength = byteLength

  function slowToString (encoding, start, end) {
    var loweredCase = false

    start = start | 0
    end = end === undefined || end === Infinity ? this.length : end | 0

    if (!encoding) encoding = 'utf8'
    if (start < 0) start = 0
    if (end > this.length) end = this.length
    if (end <= start) return ''

    while (true) {
      switch (encoding) {
        case 'hex':
          return hexSlice(this, start, end)

        case 'utf8':
        case 'utf-8':
          return utf8Slice(this, start, end)

        case 'ascii':
          return asciiSlice(this, start, end)

        case 'binary':
          return binarySlice(this, start, end)

        case 'base64':
          return base64Slice(this, start, end)

        case 'ucs2':
        case 'ucs-2':
        case 'utf16le':
        case 'utf-16le':
          return utf16leSlice(this, start, end)

        default:
          if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
          encoding = (encoding + '').toLowerCase()
          loweredCase = true
      }
    }
  }

  Buffer.prototype.toString = function toString () {
    var length = this.length | 0
    if (length === 0) return ''
    if (arguments.length === 0) return utf8Slice(this, 0, length)
    return slowToString.apply(this, arguments)
  }

  Buffer.prototype.equals = function equals (b) {
    if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
    if (this === b) return true
    return Buffer.compare(this, b) === 0
  }

  Buffer.prototype.inspect = function inspect () {
    var str = ''
    var max = exports.INSPECT_MAX_BYTES
    if (this.length > 0) {
      str = this.toString('hex', 0, max).match(/.{2}/g).join(' ')
      if (this.length > max) str += ' ... '
    }
    return '<Buffer ' + str + '>'
  }

  Buffer.prototype.compare = function compare (b) {
    if (!Buffer.isBuffer(b)) throw new TypeError('Argument must be a Buffer')
    if (this === b) return 0
    return Buffer.compare(this, b)
  }

  Buffer.prototype.indexOf = function indexOf (val, byteOffset) {
    if (byteOffset > 0x7fffffff) byteOffset = 0x7fffffff
    else if (byteOffset < -0x80000000) byteOffset = -0x80000000
    byteOffset >>= 0

    if (this.length === 0) return -1
    if (byteOffset >= this.length) return -1

    // Negative offsets start from the end of the buffer
    if (byteOffset < 0) byteOffset = Math.max(this.length + byteOffset, 0)

    if (typeof val === 'string') {
      if (val.length === 0) return -1 // special case: looking for empty string always fails
      return String.prototype.indexOf.call(this, val, byteOffset)
    }
    if (Buffer.isBuffer(val)) {
      return arrayIndexOf(this, val, byteOffset)
    }
    if (typeof val === 'number') {
      if (Buffer.TYPED_ARRAY_SUPPORT && Uint8Array.prototype.indexOf === 'function') {
        return Uint8Array.prototype.indexOf.call(this, val, byteOffset)
      }
      return arrayIndexOf(this, [ val ], byteOffset)
    }

    function arrayIndexOf (arr, val, byteOffset) {
      var foundIndex = -1
      for (var i = 0; byteOffset + i < arr.length; i++) {
        if (arr[byteOffset + i] === val[foundIndex === -1 ? 0 : i - foundIndex]) {
          if (foundIndex === -1) foundIndex = i
          if (i - foundIndex + 1 === val.length) return byteOffset + foundIndex
        } else {
          foundIndex = -1
        }
      }
      return -1
    }

    throw new TypeError('val must be string, number or Buffer')
  }

  // `get` is deprecated
  Buffer.prototype.get = function get (offset) {
    console.log('.get() is deprecated. Access using array indexes instead.')
    return this.readUInt8(offset)
  }

  // `set` is deprecated
  Buffer.prototype.set = function set (v, offset) {
    console.log('.set() is deprecated. Access using array indexes instead.')
    return this.writeUInt8(v, offset)
  }

  function hexWrite (buf, string, offset, length) {
    offset = Number(offset) || 0
    var remaining = buf.length - offset
    if (!length) {
      length = remaining
    } else {
      length = Number(length)
      if (length > remaining) {
        length = remaining
      }
    }

    // must be an even number of digits
    var strLen = string.length
    if (strLen % 2 !== 0) throw new Error('Invalid hex string')

    if (length > strLen / 2) {
      length = strLen / 2
    }
    for (var i = 0; i < length; i++) {
      var parsed = parseInt(string.substr(i * 2, 2), 16)
      if (isNaN(parsed)) throw new Error('Invalid hex string')
      buf[offset + i] = parsed
    }
    return i
  }

  function utf8Write (buf, string, offset, length) {
    return blitBuffer(utf8ToBytes(string, buf.length - offset), buf, offset, length)
  }

  function asciiWrite (buf, string, offset, length) {
    return blitBuffer(asciiToBytes(string), buf, offset, length)
  }

  function binaryWrite (buf, string, offset, length) {
    return asciiWrite(buf, string, offset, length)
  }

  function base64Write (buf, string, offset, length) {
    return blitBuffer(base64ToBytes(string), buf, offset, length)
  }

  function ucs2Write (buf, string, offset, length) {
    return blitBuffer(utf16leToBytes(string, buf.length - offset), buf, offset, length)
  }

  Buffer.prototype.write = function write (string, offset, length, encoding) {
    // Buffer#write(string)
    if (offset === undefined) {
      encoding = 'utf8'
      length = this.length
      offset = 0
    // Buffer#write(string, encoding)
    } else if (length === undefined && typeof offset === 'string') {
      encoding = offset
      length = this.length
      offset = 0
    // Buffer#write(string, offset[, length][, encoding])
    } else if (isFinite(offset)) {
      offset = offset | 0
      if (isFinite(length)) {
        length = length | 0
        if (encoding === undefined) encoding = 'utf8'
      } else {
        encoding = length
        length = undefined
      }
    // legacy write(string, encoding, offset, length) - remove in v0.13
    } else {
      var swap = encoding
      encoding = offset
      offset = length | 0
      length = swap
    }

    var remaining = this.length - offset
    if (length === undefined || length > remaining) length = remaining

    if ((string.length > 0 && (length < 0 || offset < 0)) || offset > this.length) {
      throw new RangeError('attempt to write outside buffer bounds')
    }

    if (!encoding) encoding = 'utf8'

    var loweredCase = false
    for (;;) {
      switch (encoding) {
        case 'hex':
          return hexWrite(this, string, offset, length)

        case 'utf8':
        case 'utf-8':
          return utf8Write(this, string, offset, length)

        case 'ascii':
          return asciiWrite(this, string, offset, length)

        case 'binary':
          return binaryWrite(this, string, offset, length)

        case 'base64':
          // Warning: maxLength not taken into account in base64Write
          return base64Write(this, string, offset, length)

        case 'ucs2':
        case 'ucs-2':
        case 'utf16le':
        case 'utf-16le':
          return ucs2Write(this, string, offset, length)

        default:
          if (loweredCase) throw new TypeError('Unknown encoding: ' + encoding)
          encoding = ('' + encoding).toLowerCase()
          loweredCase = true
      }
    }
  }

  Buffer.prototype.toJSON = function toJSON () {
    return {
      type: 'Buffer',
      data: Array.prototype.slice.call(this._arr || this, 0)
    }
  }

  function base64Slice (buf, start, end) {
    if (start === 0 && end === buf.length) {
      return base64.fromByteArray(buf)
    } else {
      return base64.fromByteArray(buf.slice(start, end))
    }
  }

  function utf8Slice (buf, start, end) {
    end = Math.min(buf.length, end)
    var res = []

    var i = start
    while (i < end) {
      var firstByte = buf[i]
      var codePoint = null
      var bytesPerSequence = (firstByte > 0xEF) ? 4
        : (firstByte > 0xDF) ? 3
        : (firstByte > 0xBF) ? 2
        : 1

      if (i + bytesPerSequence <= end) {
        var secondByte, thirdByte, fourthByte, tempCodePoint

        switch (bytesPerSequence) {
          case 1:
            if (firstByte < 0x80) {
              codePoint = firstByte
            }
            break
          case 2:
            secondByte = buf[i + 1]
            if ((secondByte & 0xC0) === 0x80) {
              tempCodePoint = (firstByte & 0x1F) << 0x6 | (secondByte & 0x3F)
              if (tempCodePoint > 0x7F) {
                codePoint = tempCodePoint
              }
            }
            break
          case 3:
            secondByte = buf[i + 1]
            thirdByte = buf[i + 2]
            if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80) {
              tempCodePoint = (firstByte & 0xF) << 0xC | (secondByte & 0x3F) << 0x6 | (thirdByte & 0x3F)
              if (tempCodePoint > 0x7FF && (tempCodePoint < 0xD800 || tempCodePoint > 0xDFFF)) {
                codePoint = tempCodePoint
              }
            }
            break
          case 4:
            secondByte = buf[i + 1]
            thirdByte = buf[i + 2]
            fourthByte = buf[i + 3]
            if ((secondByte & 0xC0) === 0x80 && (thirdByte & 0xC0) === 0x80 && (fourthByte & 0xC0) === 0x80) {
              tempCodePoint = (firstByte & 0xF) << 0x12 | (secondByte & 0x3F) << 0xC | (thirdByte & 0x3F) << 0x6 | (fourthByte & 0x3F)
              if (tempCodePoint > 0xFFFF && tempCodePoint < 0x110000) {
                codePoint = tempCodePoint
              }
            }
        }
      }

      if (codePoint === null) {
        // we did not generate a valid codePoint so insert a
        // replacement char (U+FFFD) and advance only 1 byte
        codePoint = 0xFFFD
        bytesPerSequence = 1
      } else if (codePoint > 0xFFFF) {
        // encode to utf16 (surrogate pair dance)
        codePoint -= 0x10000
        res.push(codePoint >>> 10 & 0x3FF | 0xD800)
        codePoint = 0xDC00 | codePoint & 0x3FF
      }

      res.push(codePoint)
      i += bytesPerSequence
    }

    return decodeCodePointsArray(res)
  }

  // Based on http://stackoverflow.com/a/22747272/680742, the browser with
  // the lowest limit is Chrome, with 0x10000 args.
  // We go 1 magnitude less, for safety
  var MAX_ARGUMENTS_LENGTH = 0x1000

  function decodeCodePointsArray (codePoints) {
    var len = codePoints.length
    if (len <= MAX_ARGUMENTS_LENGTH) {
      return String.fromCharCode.apply(String, codePoints) // avoid extra slice()
    }

    // Decode in chunks to avoid "call stack size exceeded".
    var res = ''
    var i = 0
    while (i < len) {
      res += String.fromCharCode.apply(
        String,
        codePoints.slice(i, i += MAX_ARGUMENTS_LENGTH)
      )
    }
    return res
  }

  function asciiSlice (buf, start, end) {
    var ret = ''
    end = Math.min(buf.length, end)

    for (var i = start; i < end; i++) {
      ret += String.fromCharCode(buf[i] & 0x7F)
    }
    return ret
  }

  function binarySlice (buf, start, end) {
    var ret = ''
    end = Math.min(buf.length, end)

    for (var i = start; i < end; i++) {
      ret += String.fromCharCode(buf[i])
    }
    return ret
  }

  function hexSlice (buf, start, end) {
    var len = buf.length

    if (!start || start < 0) start = 0
    if (!end || end < 0 || end > len) end = len

    var out = ''
    for (var i = start; i < end; i++) {
      out += toHex(buf[i])
    }
    return out
  }

  function utf16leSlice (buf, start, end) {
    var bytes = buf.slice(start, end)
    var res = ''
    for (var i = 0; i < bytes.length; i += 2) {
      res += String.fromCharCode(bytes[i] + bytes[i + 1] * 256)
    }
    return res
  }

  Buffer.prototype.slice = function slice (start, end) {
    var len = this.length
    start = ~~start
    end = end === undefined ? len : ~~end

    if (start < 0) {
      start += len
      if (start < 0) start = 0
    } else if (start > len) {
      start = len
    }

    if (end < 0) {
      end += len
      if (end < 0) end = 0
    } else if (end > len) {
      end = len
    }

    if (end < start) end = start

    var newBuf
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      newBuf = Buffer._augment(this.subarray(start, end))
    } else {
      var sliceLen = end - start
      newBuf = new Buffer(sliceLen, undefined)
      for (var i = 0; i < sliceLen; i++) {
        newBuf[i] = this[i + start]
      }
    }

    if (newBuf.length) newBuf.parent = this.parent || this

    return newBuf
  }

  /*
   * Need to make sure that buffer isn't trying to write out of bounds.
   */
  function checkOffset (offset, ext, length) {
    if ((offset % 1) !== 0 || offset < 0) throw new RangeError('offset is not uint')
    if (offset + ext > length) throw new RangeError('Trying to access beyond buffer length')
  }

  Buffer.prototype.readUIntLE = function readUIntLE (offset, byteLength, noAssert) {
    offset = offset | 0
    byteLength = byteLength | 0
    if (!noAssert) checkOffset(offset, byteLength, this.length)

    var val = this[offset]
    var mul = 1
    var i = 0
    while (++i < byteLength && (mul *= 0x100)) {
      val += this[offset + i] * mul
    }

    return val
  }

  Buffer.prototype.readUIntBE = function readUIntBE (offset, byteLength, noAssert) {
    offset = offset | 0
    byteLength = byteLength | 0
    if (!noAssert) {
      checkOffset(offset, byteLength, this.length)
    }

    var val = this[offset + --byteLength]
    var mul = 1
    while (byteLength > 0 && (mul *= 0x100)) {
      val += this[offset + --byteLength] * mul
    }

    return val
  }

  Buffer.prototype.readUInt8 = function readUInt8 (offset, noAssert) {
    if (!noAssert) checkOffset(offset, 1, this.length)
    return this[offset]
  }

  Buffer.prototype.readUInt16LE = function readUInt16LE (offset, noAssert) {
    if (!noAssert) checkOffset(offset, 2, this.length)
    return this[offset] | (this[offset + 1] << 8)
  }

  Buffer.prototype.readUInt16BE = function readUInt16BE (offset, noAssert) {
    if (!noAssert) checkOffset(offset, 2, this.length)
    return (this[offset] << 8) | this[offset + 1]
  }

  Buffer.prototype.readUInt32LE = function readUInt32LE (offset, noAssert) {
    if (!noAssert) checkOffset(offset, 4, this.length)

    return ((this[offset]) |
        (this[offset + 1] << 8) |
        (this[offset + 2] << 16)) +
        (this[offset + 3] * 0x1000000)
  }

  Buffer.prototype.readUInt32BE = function readUInt32BE (offset, noAssert) {
    if (!noAssert) checkOffset(offset, 4, this.length)

    return (this[offset] * 0x1000000) +
      ((this[offset + 1] << 16) |
      (this[offset + 2] << 8) |
      this[offset + 3])
  }

  Buffer.prototype.readIntLE = function readIntLE (offset, byteLength, noAssert) {
    offset = offset | 0
    byteLength = byteLength | 0
    if (!noAssert) checkOffset(offset, byteLength, this.length)

    var val = this[offset]
    var mul = 1
    var i = 0
    while (++i < byteLength && (mul *= 0x100)) {
      val += this[offset + i] * mul
    }
    mul *= 0x80

    if (val >= mul) val -= Math.pow(2, 8 * byteLength)

    return val
  }

  Buffer.prototype.readIntBE = function readIntBE (offset, byteLength, noAssert) {
    offset = offset | 0
    byteLength = byteLength | 0
    if (!noAssert) checkOffset(offset, byteLength, this.length)

    var i = byteLength
    var mul = 1
    var val = this[offset + --i]
    while (i > 0 && (mul *= 0x100)) {
      val += this[offset + --i] * mul
    }
    mul *= 0x80

    if (val >= mul) val -= Math.pow(2, 8 * byteLength)

    return val
  }

  Buffer.prototype.readInt8 = function readInt8 (offset, noAssert) {
    if (!noAssert) checkOffset(offset, 1, this.length)
    if (!(this[offset] & 0x80)) return (this[offset])
    return ((0xff - this[offset] + 1) * -1)
  }

  Buffer.prototype.readInt16LE = function readInt16LE (offset, noAssert) {
    if (!noAssert) checkOffset(offset, 2, this.length)
    var val = this[offset] | (this[offset + 1] << 8)
    return (val & 0x8000) ? val | 0xFFFF0000 : val
  }

  Buffer.prototype.readInt16BE = function readInt16BE (offset, noAssert) {
    if (!noAssert) checkOffset(offset, 2, this.length)
    var val = this[offset + 1] | (this[offset] << 8)
    return (val & 0x8000) ? val | 0xFFFF0000 : val
  }

  Buffer.prototype.readInt32LE = function readInt32LE (offset, noAssert) {
    if (!noAssert) checkOffset(offset, 4, this.length)

    return (this[offset]) |
      (this[offset + 1] << 8) |
      (this[offset + 2] << 16) |
      (this[offset + 3] << 24)
  }

  Buffer.prototype.readInt32BE = function readInt32BE (offset, noAssert) {
    if (!noAssert) checkOffset(offset, 4, this.length)

    return (this[offset] << 24) |
      (this[offset + 1] << 16) |
      (this[offset + 2] << 8) |
      (this[offset + 3])
  }

  Buffer.prototype.readFloatLE = function readFloatLE (offset, noAssert) {
    if (!noAssert) checkOffset(offset, 4, this.length)
    return ieee754.read(this, offset, true, 23, 4)
  }

  Buffer.prototype.readFloatBE = function readFloatBE (offset, noAssert) {
    if (!noAssert) checkOffset(offset, 4, this.length)
    return ieee754.read(this, offset, false, 23, 4)
  }

  Buffer.prototype.readDoubleLE = function readDoubleLE (offset, noAssert) {
    if (!noAssert) checkOffset(offset, 8, this.length)
    return ieee754.read(this, offset, true, 52, 8)
  }

  Buffer.prototype.readDoubleBE = function readDoubleBE (offset, noAssert) {
    if (!noAssert) checkOffset(offset, 8, this.length)
    return ieee754.read(this, offset, false, 52, 8)
  }

  function checkInt (buf, value, offset, ext, max, min) {
    if (!Buffer.isBuffer(buf)) throw new TypeError('buffer must be a Buffer instance')
    if (value > max || value < min) throw new RangeError('value is out of bounds')
    if (offset + ext > buf.length) throw new RangeError('index out of range')
  }

  Buffer.prototype.writeUIntLE = function writeUIntLE (value, offset, byteLength, noAssert) {
    value = +value
    offset = offset | 0
    byteLength = byteLength | 0
    if (!noAssert) checkInt(this, value, offset, byteLength, Math.pow(2, 8 * byteLength), 0)

    var mul = 1
    var i = 0
    this[offset] = value & 0xFF
    while (++i < byteLength && (mul *= 0x100)) {
      this[offset + i] = (value / mul) & 0xFF
    }

    return offset + byteLength
  }

  Buffer.prototype.writeUIntBE = function writeUIntBE (value, offset, byteLength, noAssert) {
    value = +value
    offset = offset | 0
    byteLength = byteLength | 0
    if (!noAssert) checkInt(this, value, offset, byteLength, Math.pow(2, 8 * byteLength), 0)

    var i = byteLength - 1
    var mul = 1
    this[offset + i] = value & 0xFF
    while (--i >= 0 && (mul *= 0x100)) {
      this[offset + i] = (value / mul) & 0xFF
    }

    return offset + byteLength
  }

  Buffer.prototype.writeUInt8 = function writeUInt8 (value, offset, noAssert) {
    value = +value
    offset = offset | 0
    if (!noAssert) checkInt(this, value, offset, 1, 0xff, 0)
    if (!Buffer.TYPED_ARRAY_SUPPORT) value = Math.floor(value)
    this[offset] = (value & 0xff)
    return offset + 1
  }

  function objectWriteUInt16 (buf, value, offset, littleEndian) {
    if (value < 0) value = 0xffff + value + 1
    for (var i = 0, j = Math.min(buf.length - offset, 2); i < j; i++) {
      buf[offset + i] = (value & (0xff << (8 * (littleEndian ? i : 1 - i)))) >>>
        (littleEndian ? i : 1 - i) * 8
    }
  }

  Buffer.prototype.writeUInt16LE = function writeUInt16LE (value, offset, noAssert) {
    value = +value
    offset = offset | 0
    if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = (value & 0xff)
      this[offset + 1] = (value >>> 8)
    } else {
      objectWriteUInt16(this, value, offset, true)
    }
    return offset + 2
  }

  Buffer.prototype.writeUInt16BE = function writeUInt16BE (value, offset, noAssert) {
    value = +value
    offset = offset | 0
    if (!noAssert) checkInt(this, value, offset, 2, 0xffff, 0)
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = (value >>> 8)
      this[offset + 1] = (value & 0xff)
    } else {
      objectWriteUInt16(this, value, offset, false)
    }
    return offset + 2
  }

  function objectWriteUInt32 (buf, value, offset, littleEndian) {
    if (value < 0) value = 0xffffffff + value + 1
    for (var i = 0, j = Math.min(buf.length - offset, 4); i < j; i++) {
      buf[offset + i] = (value >>> (littleEndian ? i : 3 - i) * 8) & 0xff
    }
  }

  Buffer.prototype.writeUInt32LE = function writeUInt32LE (value, offset, noAssert) {
    value = +value
    offset = offset | 0
    if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset + 3] = (value >>> 24)
      this[offset + 2] = (value >>> 16)
      this[offset + 1] = (value >>> 8)
      this[offset] = (value & 0xff)
    } else {
      objectWriteUInt32(this, value, offset, true)
    }
    return offset + 4
  }

  Buffer.prototype.writeUInt32BE = function writeUInt32BE (value, offset, noAssert) {
    value = +value
    offset = offset | 0
    if (!noAssert) checkInt(this, value, offset, 4, 0xffffffff, 0)
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = (value >>> 24)
      this[offset + 1] = (value >>> 16)
      this[offset + 2] = (value >>> 8)
      this[offset + 3] = (value & 0xff)
    } else {
      objectWriteUInt32(this, value, offset, false)
    }
    return offset + 4
  }

  Buffer.prototype.writeIntLE = function writeIntLE (value, offset, byteLength, noAssert) {
    value = +value
    offset = offset | 0
    if (!noAssert) {
      var limit = Math.pow(2, 8 * byteLength - 1)

      checkInt(this, value, offset, byteLength, limit - 1, -limit)
    }

    var i = 0
    var mul = 1
    var sub = value < 0 ? 1 : 0
    this[offset] = value & 0xFF
    while (++i < byteLength && (mul *= 0x100)) {
      this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
    }

    return offset + byteLength
  }

  Buffer.prototype.writeIntBE = function writeIntBE (value, offset, byteLength, noAssert) {
    value = +value
    offset = offset | 0
    if (!noAssert) {
      var limit = Math.pow(2, 8 * byteLength - 1)

      checkInt(this, value, offset, byteLength, limit - 1, -limit)
    }

    var i = byteLength - 1
    var mul = 1
    var sub = value < 0 ? 1 : 0
    this[offset + i] = value & 0xFF
    while (--i >= 0 && (mul *= 0x100)) {
      this[offset + i] = ((value / mul) >> 0) - sub & 0xFF
    }

    return offset + byteLength
  }

  Buffer.prototype.writeInt8 = function writeInt8 (value, offset, noAssert) {
    value = +value
    offset = offset | 0
    if (!noAssert) checkInt(this, value, offset, 1, 0x7f, -0x80)
    if (!Buffer.TYPED_ARRAY_SUPPORT) value = Math.floor(value)
    if (value < 0) value = 0xff + value + 1
    this[offset] = (value & 0xff)
    return offset + 1
  }

  Buffer.prototype.writeInt16LE = function writeInt16LE (value, offset, noAssert) {
    value = +value
    offset = offset | 0
    if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = (value & 0xff)
      this[offset + 1] = (value >>> 8)
    } else {
      objectWriteUInt16(this, value, offset, true)
    }
    return offset + 2
  }

  Buffer.prototype.writeInt16BE = function writeInt16BE (value, offset, noAssert) {
    value = +value
    offset = offset | 0
    if (!noAssert) checkInt(this, value, offset, 2, 0x7fff, -0x8000)
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = (value >>> 8)
      this[offset + 1] = (value & 0xff)
    } else {
      objectWriteUInt16(this, value, offset, false)
    }
    return offset + 2
  }

  Buffer.prototype.writeInt32LE = function writeInt32LE (value, offset, noAssert) {
    value = +value
    offset = offset | 0
    if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = (value & 0xff)
      this[offset + 1] = (value >>> 8)
      this[offset + 2] = (value >>> 16)
      this[offset + 3] = (value >>> 24)
    } else {
      objectWriteUInt32(this, value, offset, true)
    }
    return offset + 4
  }

  Buffer.prototype.writeInt32BE = function writeInt32BE (value, offset, noAssert) {
    value = +value
    offset = offset | 0
    if (!noAssert) checkInt(this, value, offset, 4, 0x7fffffff, -0x80000000)
    if (value < 0) value = 0xffffffff + value + 1
    if (Buffer.TYPED_ARRAY_SUPPORT) {
      this[offset] = (value >>> 24)
      this[offset + 1] = (value >>> 16)
      this[offset + 2] = (value >>> 8)
      this[offset + 3] = (value & 0xff)
    } else {
      objectWriteUInt32(this, value, offset, false)
    }
    return offset + 4
  }

  function checkIEEE754 (buf, value, offset, ext, max, min) {
    if (value > max || value < min) throw new RangeError('value is out of bounds')
    if (offset + ext > buf.length) throw new RangeError('index out of range')
    if (offset < 0) throw new RangeError('index out of range')
  }

  function writeFloat (buf, value, offset, littleEndian, noAssert) {
    if (!noAssert) {
      checkIEEE754(buf, value, offset, 4, 3.4028234663852886e+38, -3.4028234663852886e+38)
    }
    ieee754.write(buf, value, offset, littleEndian, 23, 4)
    return offset + 4
  }

  Buffer.prototype.writeFloatLE = function writeFloatLE (value, offset, noAssert) {
    return writeFloat(this, value, offset, true, noAssert)
  }

  Buffer.prototype.writeFloatBE = function writeFloatBE (value, offset, noAssert) {
    return writeFloat(this, value, offset, false, noAssert)
  }

  function writeDouble (buf, value, offset, littleEndian, noAssert) {
    if (!noAssert) {
      checkIEEE754(buf, value, offset, 8, 1.7976931348623157E+308, -1.7976931348623157E+308)
    }
    ieee754.write(buf, value, offset, littleEndian, 52, 8)
    return offset + 8
  }

  Buffer.prototype.writeDoubleLE = function writeDoubleLE (value, offset, noAssert) {
    return writeDouble(this, value, offset, true, noAssert)
  }

  Buffer.prototype.writeDoubleBE = function writeDoubleBE (value, offset, noAssert) {
    return writeDouble(this, value, offset, false, noAssert)
  }

  // copy(targetBuffer, targetStart=0, sourceStart=0, sourceEnd=buffer.length)
  Buffer.prototype.copy = function copy (target, targetStart, start, end) {
    if (!start) start = 0
    if (!end && end !== 0) end = this.length
    if (targetStart >= target.length) targetStart = target.length
    if (!targetStart) targetStart = 0
    if (end > 0 && end < start) end = start

    // Copy 0 bytes; we're done
    if (end === start) return 0
    if (target.length === 0 || this.length === 0) return 0

    // Fatal error conditions
    if (targetStart < 0) {
      throw new RangeError('targetStart out of bounds')
    }
    if (start < 0 || start >= this.length) throw new RangeError('sourceStart out of bounds')
    if (end < 0) throw new RangeError('sourceEnd out of bounds')

    // Are we oob?
    if (end > this.length) end = this.length
    if (target.length - targetStart < end - start) {
      end = target.length - targetStart + start
    }

    var len = end - start
    var i

    if (this === target && start < targetStart && targetStart < end) {
      // descending copy from end
      for (i = len - 1; i >= 0; i--) {
        target[i + targetStart] = this[i + start]
      }
    } else if (len < 1000 || !Buffer.TYPED_ARRAY_SUPPORT) {
      // ascending copy from start
      for (i = 0; i < len; i++) {
        target[i + targetStart] = this[i + start]
      }
    } else {
      target._set(this.subarray(start, start + len), targetStart)
    }

    return len
  }

  // fill(value, start=0, end=buffer.length)
  Buffer.prototype.fill = function fill (value, start, end) {
    if (!value) value = 0
    if (!start) start = 0
    if (!end) end = this.length

    if (end < start) throw new RangeError('end < start')

    // Fill 0 bytes; we're done
    if (end === start) return
    if (this.length === 0) return

    if (start < 0 || start >= this.length) throw new RangeError('start out of bounds')
    if (end < 0 || end > this.length) throw new RangeError('end out of bounds')

    var i
    if (typeof value === 'number') {
      for (i = start; i < end; i++) {
        this[i] = value
      }
    } else {
      var bytes = utf8ToBytes(value.toString())
      var len = bytes.length
      for (i = start; i < end; i++) {
        this[i] = bytes[i % len]
      }
    }

    return this
  }

  /**
   * Creates a new `ArrayBuffer` with the *copied* memory of the buffer instance.
   * Added in Node 0.12. Only available in browsers that support ArrayBuffer.
   */
  Buffer.prototype.toArrayBuffer = function toArrayBuffer () {
    if (typeof Uint8Array !== 'undefined') {
      if (Buffer.TYPED_ARRAY_SUPPORT) {
        return (new Buffer(this)).buffer
      } else {
        var buf = new Uint8Array(this.length)
        for (var i = 0, len = buf.length; i < len; i += 1) {
          buf[i] = this[i]
        }
        return buf.buffer
      }
    } else {
      throw new TypeError('Buffer.toArrayBuffer not supported in this browser')
    }
  }

  // HELPER FUNCTIONS
  // ================

  var BP = Buffer.prototype

  /**
   * Augment a Uint8Array *instance* (not the Uint8Array class!) with Buffer methods
   */
  Buffer._augment = function _augment (arr) {
    arr.constructor = Buffer
    arr._isBuffer = true

    // save reference to original Uint8Array set method before overwriting
    arr._set = arr.set

    // deprecated
    arr.get = BP.get
    arr.set = BP.set

    arr.write = BP.write
    arr.toString = BP.toString
    arr.toLocaleString = BP.toString
    arr.toJSON = BP.toJSON
    arr.equals = BP.equals
    arr.compare = BP.compare
    arr.indexOf = BP.indexOf
    arr.copy = BP.copy
    arr.slice = BP.slice
    arr.readUIntLE = BP.readUIntLE
    arr.readUIntBE = BP.readUIntBE
    arr.readUInt8 = BP.readUInt8
    arr.readUInt16LE = BP.readUInt16LE
    arr.readUInt16BE = BP.readUInt16BE
    arr.readUInt32LE = BP.readUInt32LE
    arr.readUInt32BE = BP.readUInt32BE
    arr.readIntLE = BP.readIntLE
    arr.readIntBE = BP.readIntBE
    arr.readInt8 = BP.readInt8
    arr.readInt16LE = BP.readInt16LE
    arr.readInt16BE = BP.readInt16BE
    arr.readInt32LE = BP.readInt32LE
    arr.readInt32BE = BP.readInt32BE
    arr.readFloatLE = BP.readFloatLE
    arr.readFloatBE = BP.readFloatBE
    arr.readDoubleLE = BP.readDoubleLE
    arr.readDoubleBE = BP.readDoubleBE
    arr.writeUInt8 = BP.writeUInt8
    arr.writeUIntLE = BP.writeUIntLE
    arr.writeUIntBE = BP.writeUIntBE
    arr.writeUInt16LE = BP.writeUInt16LE
    arr.writeUInt16BE = BP.writeUInt16BE
    arr.writeUInt32LE = BP.writeUInt32LE
    arr.writeUInt32BE = BP.writeUInt32BE
    arr.writeIntLE = BP.writeIntLE
    arr.writeIntBE = BP.writeIntBE
    arr.writeInt8 = BP.writeInt8
    arr.writeInt16LE = BP.writeInt16LE
    arr.writeInt16BE = BP.writeInt16BE
    arr.writeInt32LE = BP.writeInt32LE
    arr.writeInt32BE = BP.writeInt32BE
    arr.writeFloatLE = BP.writeFloatLE
    arr.writeFloatBE = BP.writeFloatBE
    arr.writeDoubleLE = BP.writeDoubleLE
    arr.writeDoubleBE = BP.writeDoubleBE
    arr.fill = BP.fill
    arr.inspect = BP.inspect
    arr.toArrayBuffer = BP.toArrayBuffer

    return arr
  }

  var INVALID_BASE64_RE = /[^+\/0-9A-Za-z-_]/g

  function base64clean (str) {
    // Node strips out invalid characters like \n and \t from the string, base64-js does not
    str = stringtrim(str).replace(INVALID_BASE64_RE, '')
    // Node converts strings with length < 2 to ''
    if (str.length < 2) return ''
    // Node allows for non-padded base64 strings (missing trailing ===), base64-js does not
    while (str.length % 4 !== 0) {
      str = str + '='
    }
    return str
  }

  function stringtrim (str) {
    if (str.trim) return str.trim()
    return str.replace(/^\s+|\s+$/g, '')
  }

  function toHex (n) {
    if (n < 16) return '0' + n.toString(16)
    return n.toString(16)
  }

  function utf8ToBytes (string, units) {
    units = units || Infinity
    var codePoint
    var length = string.length
    var leadSurrogate = null
    var bytes = []

    for (var i = 0; i < length; i++) {
      codePoint = string.charCodeAt(i)

      // is surrogate component
      if (codePoint > 0xD7FF && codePoint < 0xE000) {
        // last char was a lead
        if (!leadSurrogate) {
          // no lead yet
          if (codePoint > 0xDBFF) {
            // unexpected trail
            if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
            continue
          } else if (i + 1 === length) {
            // unpaired lead
            if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
            continue
          }

          // valid lead
          leadSurrogate = codePoint

          continue
        }

        // 2 leads in a row
        if (codePoint < 0xDC00) {
          if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
          leadSurrogate = codePoint
          continue
        }

        // valid surrogate pair
        codePoint = (leadSurrogate - 0xD800 << 10 | codePoint - 0xDC00) + 0x10000
      } else if (leadSurrogate) {
        // valid bmp char, but last char was a lead
        if ((units -= 3) > -1) bytes.push(0xEF, 0xBF, 0xBD)
      }

      leadSurrogate = null

      // encode utf8
      if (codePoint < 0x80) {
        if ((units -= 1) < 0) break
        bytes.push(codePoint)
      } else if (codePoint < 0x800) {
        if ((units -= 2) < 0) break
        bytes.push(
          codePoint >> 0x6 | 0xC0,
          codePoint & 0x3F | 0x80
        )
      } else if (codePoint < 0x10000) {
        if ((units -= 3) < 0) break
        bytes.push(
          codePoint >> 0xC | 0xE0,
          codePoint >> 0x6 & 0x3F | 0x80,
          codePoint & 0x3F | 0x80
        )
      } else if (codePoint < 0x110000) {
        if ((units -= 4) < 0) break
        bytes.push(
          codePoint >> 0x12 | 0xF0,
          codePoint >> 0xC & 0x3F | 0x80,
          codePoint >> 0x6 & 0x3F | 0x80,
          codePoint & 0x3F | 0x80
        )
      } else {
        throw new Error('Invalid code point')
      }
    }

    return bytes
  }

  function asciiToBytes (str) {
    var byteArray = []
    for (var i = 0; i < str.length; i++) {
      // Node's code seems to be doing this and not & 0x7F..
      byteArray.push(str.charCodeAt(i) & 0xFF)
    }
    return byteArray
  }

  function utf16leToBytes (str, units) {
    var c, hi, lo
    var byteArray = []
    for (var i = 0; i < str.length; i++) {
      if ((units -= 2) < 0) break

      c = str.charCodeAt(i)
      hi = c >> 8
      lo = c % 256
      byteArray.push(lo)
      byteArray.push(hi)
    }

    return byteArray
  }

  function base64ToBytes (str) {
    return base64.toByteArray(base64clean(str))
  }

  function blitBuffer (src, dst, offset, length) {
    for (var i = 0; i < length; i++) {
      if ((i + offset >= dst.length) || (i >= src.length)) break
      dst[i + offset] = src[i]
    }
    return i
  }

  }).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
  },{"base64-js":36,"ieee754":40,"isarray":38}],38:[function(require,module,exports){
  var toString = {}.toString;

  module.exports = Array.isArray || function (arr) {
    return toString.call(arr) == '[object Array]';
  };

  },{}],39:[function(require,module,exports){
  // Copyright Joyent, Inc. and other Node contributors.
  //
  // Permission is hereby granted, free of charge, to any person obtaining a
  // copy of this software and associated documentation files (the
  // "Software"), to deal in the Software without restriction, including
  // without limitation the rights to use, copy, modify, merge, publish,
  // distribute, sublicense, and/or sell copies of the Software, and to permit
  // persons to whom the Software is furnished to do so, subject to the
  // following conditions:
  //
  // The above copyright notice and this permission notice shall be included
  // in all copies or substantial portions of the Software.
  //
  // THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
  // OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
  // MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
  // NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
  // DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
  // OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
  // USE OR OTHER DEALINGS IN THE SOFTWARE.

  function EventEmitter() {
    this._events = this._events || {};
    this._maxListeners = this._maxListeners || undefined;
  }
  module.exports = EventEmitter;

  // Backwards-compat with node 0.10.x
  EventEmitter.EventEmitter = EventEmitter;

  EventEmitter.prototype._events = undefined;
  EventEmitter.prototype._maxListeners = undefined;

  // By default EventEmitters will print a warning if more than 10 listeners are
  // added to it. This is a useful default which helps finding memory leaks.
  EventEmitter.defaultMaxListeners = 10;

  // Obviously not all Emitters should be limited to 10. This function allows
  // that to be increased. Set to zero for unlimited.
  EventEmitter.prototype.setMaxListeners = function(n) {
    if (!isNumber(n) || n < 0 || isNaN(n))
      throw TypeError('n must be a positive number');
    this._maxListeners = n;
    return this;
  };

  EventEmitter.prototype.emit = function(type) {
    var er, handler, len, args, i, listeners;

    if (!this._events)
      this._events = {};

    // If there is no 'error' event listener then throw.
    if (type === 'error') {
      if (!this._events.error ||
          (isObject(this._events.error) && !this._events.error.length)) {
        er = arguments[1];
        if (er instanceof Error) {
          throw er; // Unhandled 'error' event
        }
        throw TypeError('Uncaught, unspecified "error" event.');
      }
    }

    handler = this._events[type];

    if (isUndefined(handler))
      return false;

    if (isFunction(handler)) {
      switch (arguments.length) {
        // fast cases
        case 1:
          handler.call(this);
          break;
        case 2:
          handler.call(this, arguments[1]);
          break;
        case 3:
          handler.call(this, arguments[1], arguments[2]);
          break;
        // slower
        default:
          len = arguments.length;
          args = new Array(len - 1);
          for (i = 1; i < len; i++)
            args[i - 1] = arguments[i];
          handler.apply(this, args);
      }
    } else if (isObject(handler)) {
      len = arguments.length;
      args = new Array(len - 1);
      for (i = 1; i < len; i++)
        args[i - 1] = arguments[i];

      listeners = handler.slice();
      len = listeners.length;
      for (i = 0; i < len; i++)
        listeners[i].apply(this, args);
    }

    return true;
  };

  EventEmitter.prototype.addListener = function(type, listener) {
    var m;

    if (!isFunction(listener))
      throw TypeError('listener must be a function');

    if (!this._events)
      this._events = {};

    // To avoid recursion in the case that type === "newListener"! Before
    // adding it to the listeners, first emit "newListener".
    if (this._events.newListener)
      this.emit('newListener', type,
                isFunction(listener.listener) ?
                listener.listener : listener);

    if (!this._events[type])
      // Optimize the case of one listener. Don't need the extra array object.
      this._events[type] = listener;
    else if (isObject(this._events[type]))
      // If we've already got an array, just append.
      this._events[type].push(listener);
    else
      // Adding the second element, need to change to array.
      this._events[type] = [this._events[type], listener];

    // Check for listener leak
    if (isObject(this._events[type]) && !this._events[type].warned) {
      var m;
      if (!isUndefined(this._maxListeners)) {
        m = this._maxListeners;
      } else {
        m = EventEmitter.defaultMaxListeners;
      }

      if (m && m > 0 && this._events[type].length > m) {
        this._events[type].warned = true;
        console.error('(node) warning: possible EventEmitter memory ' +
                      'leak detected. %d listeners added. ' +
                      'Use emitter.setMaxListeners() to increase limit.',
                      this._events[type].length);
        if (typeof console.trace === 'function') {
          // not supported in IE 10
          console.trace();
        }
      }
    }

    return this;
  };

  EventEmitter.prototype.on = EventEmitter.prototype.addListener;

  EventEmitter.prototype.once = function(type, listener) {
    if (!isFunction(listener))
      throw TypeError('listener must be a function');

    var fired = false;

    function g() {
      this.removeListener(type, g);

      if (!fired) {
        fired = true;
        listener.apply(this, arguments);
      }
    }

    g.listener = listener;
    this.on(type, g);

    return this;
  };

  // emits a 'removeListener' event iff the listener was removed
  EventEmitter.prototype.removeListener = function(type, listener) {
    var list, position, length, i;

    if (!isFunction(listener))
      throw TypeError('listener must be a function');

    if (!this._events || !this._events[type])
      return this;

    list = this._events[type];
    length = list.length;
    position = -1;

    if (list === listener ||
        (isFunction(list.listener) && list.listener === listener)) {
      delete this._events[type];
      if (this._events.removeListener)
        this.emit('removeListener', type, listener);

    } else if (isObject(list)) {
      for (i = length; i-- > 0;) {
        if (list[i] === listener ||
            (list[i].listener && list[i].listener === listener)) {
          position = i;
          break;
        }
      }

      if (position < 0)
        return this;

      if (list.length === 1) {
        list.length = 0;
        delete this._events[type];
      } else {
        list.splice(position, 1);
      }

      if (this._events.removeListener)
        this.emit('removeListener', type, listener);
    }

    return this;
  };

  EventEmitter.prototype.removeAllListeners = function(type) {
    var key, listeners;

    if (!this._events)
      return this;

    // not listening for removeListener, no need to emit
    if (!this._events.removeListener) {
      if (arguments.length === 0)
        this._events = {};
      else if (this._events[type])
        delete this._events[type];
      return this;
    }

    // emit removeListener for all listeners on all events
    if (arguments.length === 0) {
      for (key in this._events) {
        if (key === 'removeListener') continue;
        this.removeAllListeners(key);
      }
      this.removeAllListeners('removeListener');
      this._events = {};
      return this;
    }

    listeners = this._events[type];

    if (isFunction(listeners)) {
      this.removeListener(type, listeners);
    } else {
      // LIFO order
      while (listeners.length)
        this.removeListener(type, listeners[listeners.length - 1]);
    }
    delete this._events[type];

    return this;
  };

  EventEmitter.prototype.listeners = function(type) {
    var ret;
    if (!this._events || !this._events[type])
      ret = [];
    else if (isFunction(this._events[type]))
      ret = [this._events[type]];
    else
      ret = this._events[type].slice();
    return ret;
  };

  EventEmitter.listenerCount = function(emitter, type) {
    var ret;
    if (!emitter._events || !emitter._events[type])
      ret = 0;
    else if (isFunction(emitter._events[type]))
      ret = 1;
    else
      ret = emitter._events[type].length;
    return ret;
  };

  function isFunction(arg) {
    return typeof arg === 'function';
  }

  function isNumber(arg) {
    return typeof arg === 'number';
  }

  function isObject(arg) {
    return typeof arg === 'object' && arg !== null;
  }

  function isUndefined(arg) {
    return arg === void 0;
  }

  },{}],40:[function(require,module,exports){
  exports.read = function (buffer, offset, isLE, mLen, nBytes) {
    var e, m
    var eLen = (nBytes * 8) - mLen - 1
    var eMax = (1 << eLen) - 1
    var eBias = eMax >> 1
    var nBits = -7
    var i = isLE ? (nBytes - 1) : 0
    var d = isLE ? -1 : 1
    var s = buffer[offset + i]

    i += d

    e = s & ((1 << (-nBits)) - 1)
    s >>= (-nBits)
    nBits += eLen
    for (; nBits > 0; e = (e * 256) + buffer[offset + i], i += d, nBits -= 8) {}

    m = e & ((1 << (-nBits)) - 1)
    e >>= (-nBits)
    nBits += mLen
    for (; nBits > 0; m = (m * 256) + buffer[offset + i], i += d, nBits -= 8) {}

    if (e === 0) {
      e = 1 - eBias
    } else if (e === eMax) {
      return m ? NaN : ((s ? -1 : 1) * Infinity)
    } else {
      m = m + Math.pow(2, mLen)
      e = e - eBias
    }
    return (s ? -1 : 1) * m * Math.pow(2, e - mLen)
  }

  exports.write = function (buffer, value, offset, isLE, mLen, nBytes) {
    var e, m, c
    var eLen = (nBytes * 8) - mLen - 1
    var eMax = (1 << eLen) - 1
    var eBias = eMax >> 1
    var rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0)
    var i = isLE ? 0 : (nBytes - 1)
    var d = isLE ? 1 : -1
    var s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0

    value = Math.abs(value)

    if (isNaN(value) || value === Infinity) {
      m = isNaN(value) ? 1 : 0
      e = eMax
    } else {
      e = Math.floor(Math.log(value) / Math.LN2)
      if (value * (c = Math.pow(2, -e)) < 1) {
        e--
        c *= 2
      }
      if (e + eBias >= 1) {
        value += rt / c
      } else {
        value += rt * Math.pow(2, 1 - eBias)
      }
      if (value * c >= 2) {
        e++
        c /= 2
      }

      if (e + eBias >= eMax) {
        m = 0
        e = eMax
      } else if (e + eBias >= 1) {
        m = ((value * c) - 1) * Math.pow(2, mLen)
        e = e + eBias
      } else {
        m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen)
        e = 0
      }
    }

    for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8) {}

    e = (e << mLen) | m
    eLen += mLen
    for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8) {}

    buffer[offset + i - d] |= s * 128
  }

  },{}],41:[function(require,module,exports){
  if (typeof Object.create === 'function') {
    // implementation from standard node.js 'util' module
    module.exports = function inherits(ctor, superCtor) {
      ctor.super_ = superCtor
      ctor.prototype = Object.create(superCtor.prototype, {
        constructor: {
          value: ctor,
          enumerable: false,
          writable: true,
          configurable: true
        }
      });
    };
  } else {
    // old school shim for old browsers
    module.exports = function inherits(ctor, superCtor) {
      ctor.super_ = superCtor
      var TempCtor = function () {}
      TempCtor.prototype = superCtor.prototype
      ctor.prototype = new TempCtor()
      ctor.prototype.constructor = ctor
    }
  }

  },{}],42:[function(require,module,exports){
  // shim for using process in browser

  var process = module.exports = {};
  var queue = [];
  var draining = false;

  function drainQueue() {
      if (draining) {
          return;
      }
      draining = true;
      var currentQueue;
      var len = queue.length;
      while(len) {
          currentQueue = queue;
          queue = [];
          var i = -1;
          while (++i < len) {
              currentQueue[i]();
          }
          len = queue.length;
      }
      draining = false;
  }
  process.nextTick = function (fun) {
      queue.push(fun);
      if (!draining) {
          setTimeout(drainQueue, 0);
      }
  };

  process.title = 'browser';
  process.browser = true;
  process.env = {};
  process.argv = [];
  process.version = ''; // empty string to avoid regexp issues
  process.versions = {};

  function noop() {}

  process.on = noop;
  process.addListener = noop;
  process.once = noop;
  process.off = noop;
  process.removeListener = noop;
  process.removeAllListeners = noop;
  process.emit = noop;

  process.binding = function (name) {
      throw new Error('process.binding is not supported');
  };

  // TODO(shtylman)
  process.cwd = function () { return '/' };
  process.chdir = function (dir) {
      throw new Error('process.chdir is not supported');
  };
  process.umask = function() { return 0; };

  },{}],43:[function(require,module,exports){
  module.exports = function isBuffer(arg) {
    return arg && typeof arg === 'object'
      && typeof arg.copy === 'function'
      && typeof arg.fill === 'function'
      && typeof arg.readUInt8 === 'function';
  }
  },{}],44:[function(require,module,exports){
  (function (process,global){
  // Copyright Joyent, Inc. and other Node contributors.
  //
  // Permission is hereby granted, free of charge, to any person obtaining a
  // copy of this software and associated documentation files (the
  // "Software"), to deal in the Software without restriction, including
  // without limitation the rights to use, copy, modify, merge, publish,
  // distribute, sublicense, and/or sell copies of the Software, and to permit
  // persons to whom the Software is furnished to do so, subject to the
  // following conditions:
  //
  // The above copyright notice and this permission notice shall be included
  // in all copies or substantial portions of the Software.
  //
  // THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
  // OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
  // MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
  // NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
  // DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
  // OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
  // USE OR OTHER DEALINGS IN THE SOFTWARE.

  var formatRegExp = /%[sdj%]/g;
  exports.format = function(f) {
    if (!isString(f)) {
      var objects = [];
      for (var i = 0; i < arguments.length; i++) {
        objects.push(inspect(arguments[i]));
      }
      return objects.join(' ');
    }

    var i = 1;
    var args = arguments;
    var len = args.length;
    var str = String(f).replace(formatRegExp, function(x) {
      if (x === '%%') return '%';
      if (i >= len) return x;
      switch (x) {
        case '%s': return String(args[i++]);
        case '%d': return Number(args[i++]);
        case '%j':
          try {
            return JSON.stringify(args[i++]);
          } catch (_) {
            return '[Circular]';
          }
        default:
          return x;
      }
    });
    for (var x = args[i]; i < len; x = args[++i]) {
      if (isNull(x) || !isObject(x)) {
        str += ' ' + x;
      } else {
        str += ' ' + inspect(x);
      }
    }
    return str;
  };


  // Mark that a method should not be used.
  // Returns a modified function which warns once by default.
  // If --no-deprecation is set, then it is a no-op.
  exports.deprecate = function(fn, msg) {
    // Allow for deprecating things in the process of starting up.
    if (isUndefined(global.process)) {
      return function() {
        return exports.deprecate(fn, msg).apply(this, arguments);
      };
    }

    if (process.noDeprecation === true) {
      return fn;
    }

    var warned = false;
    function deprecated() {
      if (!warned) {
        if (process.throwDeprecation) {
          throw new Error(msg);
        } else if (process.traceDeprecation) {
          console.trace(msg);
        } else {
          console.error(msg);
        }
        warned = true;
      }
      return fn.apply(this, arguments);
    }

    return deprecated;
  };


  var debugs = {};
  var debugEnviron;
  exports.debuglog = function(set) {
    if (isUndefined(debugEnviron))
      debugEnviron = process.env.NODE_DEBUG || '';
    set = set.toUpperCase();
    if (!debugs[set]) {
      if (new RegExp('\\b' + set + '\\b', 'i').test(debugEnviron)) {
        var pid = process.pid;
        debugs[set] = function() {
          var msg = exports.format.apply(exports, arguments);
          console.error('%s %d: %s', set, pid, msg);
        };
      } else {
        debugs[set] = function() {};
      }
    }
    return debugs[set];
  };


  /**
   * Echos the value of a value. Trys to print the value out
   * in the best way possible given the different types.
   *
   * @param {Object} obj The object to print out.
   * @param {Object} opts Optional options object that alters the output.
   */
  /* legacy: obj, showHidden, depth, colors*/
  function inspect(obj, opts) {
    // default options
    var ctx = {
      seen: [],
      stylize: stylizeNoColor
    };
    // legacy...
    if (arguments.length >= 3) ctx.depth = arguments[2];
    if (arguments.length >= 4) ctx.colors = arguments[3];
    if (isBoolean(opts)) {
      // legacy...
      ctx.showHidden = opts;
    } else if (opts) {
      // got an "options" object
      exports._extend(ctx, opts);
    }
    // set default options
    if (isUndefined(ctx.showHidden)) ctx.showHidden = false;
    if (isUndefined(ctx.depth)) ctx.depth = 2;
    if (isUndefined(ctx.colors)) ctx.colors = false;
    if (isUndefined(ctx.customInspect)) ctx.customInspect = true;
    if (ctx.colors) ctx.stylize = stylizeWithColor;
    return formatValue(ctx, obj, ctx.depth);
  }
  exports.inspect = inspect;


  // http://en.wikipedia.org/wiki/ANSI_escape_code#graphics
  inspect.colors = {
    'bold' : [1, 22],
    'italic' : [3, 23],
    'underline' : [4, 24],
    'inverse' : [7, 27],
    'white' : [37, 39],
    'grey' : [90, 39],
    'black' : [30, 39],
    'blue' : [34, 39],
    'cyan' : [36, 39],
    'green' : [32, 39],
    'magenta' : [35, 39],
    'red' : [31, 39],
    'yellow' : [33, 39]
  };

  // Don't use 'blue' not visible on cmd.exe
  inspect.styles = {
    'special': 'cyan',
    'number': 'yellow',
    'boolean': 'yellow',
    'undefined': 'grey',
    'null': 'bold',
    'string': 'green',
    'date': 'magenta',
    // "name": intentionally not styling
    'regexp': 'red'
  };


  function stylizeWithColor(str, styleType) {
    var style = inspect.styles[styleType];

    if (style) {
      return '\u001b[' + inspect.colors[style][0] + 'm' + str +
             '\u001b[' + inspect.colors[style][1] + 'm';
    } else {
      return str;
    }
  }


  function stylizeNoColor(str, styleType) {
    return str;
  }


  function arrayToHash(array) {
    var hash = {};

    array.forEach(function(val, idx) {
      hash[val] = true;
    });

    return hash;
  }


  function formatValue(ctx, value, recurseTimes) {
    // Provide a hook for user-specified inspect functions.
    // Check that value is an object with an inspect function on it
    if (ctx.customInspect &&
        value &&
        isFunction(value.inspect) &&
        // Filter out the util module, it's inspect function is special
        value.inspect !== exports.inspect &&
        // Also filter out any prototype objects using the circular check.
        !(value.constructor && value.constructor.prototype === value)) {
      var ret = value.inspect(recurseTimes, ctx);
      if (!isString(ret)) {
        ret = formatValue(ctx, ret, recurseTimes);
      }
      return ret;
    }

    // Primitive types cannot have properties
    var primitive = formatPrimitive(ctx, value);
    if (primitive) {
      return primitive;
    }

    // Look up the keys of the object.
    var keys = Object.keys(value);
    var visibleKeys = arrayToHash(keys);

    if (ctx.showHidden) {
      keys = Object.getOwnPropertyNames(value);
    }

    // IE doesn't make error fields non-enumerable
    // http://msdn.microsoft.com/en-us/library/ie/dww52sbt(v=vs.94).aspx
    if (isError(value)
        && (keys.indexOf('message') >= 0 || keys.indexOf('description') >= 0)) {
      return formatError(value);
    }

    // Some type of object without properties can be shortcutted.
    if (keys.length === 0) {
      if (isFunction(value)) {
        var name = value.name ? ': ' + value.name : '';
        return ctx.stylize('[Function' + name + ']', 'special');
      }
      if (isRegExp(value)) {
        return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
      }
      if (isDate(value)) {
        return ctx.stylize(Date.prototype.toString.call(value), 'date');
      }
      if (isError(value)) {
        return formatError(value);
      }
    }

    var base = '', array = false, braces = ['{', '}'];

    // Make Array say that they are Array
    if (isArray(value)) {
      array = true;
      braces = ['[', ']'];
    }

    // Make functions say that they are functions
    if (isFunction(value)) {
      var n = value.name ? ': ' + value.name : '';
      base = ' [Function' + n + ']';
    }

    // Make RegExps say that they are RegExps
    if (isRegExp(value)) {
      base = ' ' + RegExp.prototype.toString.call(value);
    }

    // Make dates with properties first say the date
    if (isDate(value)) {
      base = ' ' + Date.prototype.toUTCString.call(value);
    }

    // Make error with message first say the error
    if (isError(value)) {
      base = ' ' + formatError(value);
    }

    if (keys.length === 0 && (!array || value.length == 0)) {
      return braces[0] + base + braces[1];
    }

    if (recurseTimes < 0) {
      if (isRegExp(value)) {
        return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
      } else {
        return ctx.stylize('[Object]', 'special');
      }
    }

    ctx.seen.push(value);

    var output;
    if (array) {
      output = formatArray(ctx, value, recurseTimes, visibleKeys, keys);
    } else {
      output = keys.map(function(key) {
        return formatProperty(ctx, value, recurseTimes, visibleKeys, key, array);
      });
    }

    ctx.seen.pop();

    return reduceToSingleString(output, base, braces);
  }


  function formatPrimitive(ctx, value) {
    if (isUndefined(value))
      return ctx.stylize('undefined', 'undefined');
    if (isString(value)) {
      var simple = '\'' + JSON.stringify(value).replace(/^"|"$/g, '')
                                               .replace(/'/g, "\\'")
                                               .replace(/\\"/g, '"') + '\'';
      return ctx.stylize(simple, 'string');
    }
    if (isNumber(value))
      return ctx.stylize('' + value, 'number');
    if (isBoolean(value))
      return ctx.stylize('' + value, 'boolean');
    // For some reason typeof null is "object", so special case here.
    if (isNull(value))
      return ctx.stylize('null', 'null');
  }


  function formatError(value) {
    return '[' + Error.prototype.toString.call(value) + ']';
  }


  function formatArray(ctx, value, recurseTimes, visibleKeys, keys) {
    var output = [];
    for (var i = 0, l = value.length; i < l; ++i) {
      if (hasOwnProperty(value, String(i))) {
        output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
            String(i), true));
      } else {
        output.push('');
      }
    }
    keys.forEach(function(key) {
      if (!key.match(/^\d+$/)) {
        output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
            key, true));
      }
    });
    return output;
  }


  function formatProperty(ctx, value, recurseTimes, visibleKeys, key, array) {
    var name, str, desc;
    desc = Object.getOwnPropertyDescriptor(value, key) || { value: value[key] };
    if (desc.get) {
      if (desc.set) {
        str = ctx.stylize('[Getter/Setter]', 'special');
      } else {
        str = ctx.stylize('[Getter]', 'special');
      }
    } else {
      if (desc.set) {
        str = ctx.stylize('[Setter]', 'special');
      }
    }
    if (!hasOwnProperty(visibleKeys, key)) {
      name = '[' + key + ']';
    }
    if (!str) {
      if (ctx.seen.indexOf(desc.value) < 0) {
        if (isNull(recurseTimes)) {
          str = formatValue(ctx, desc.value, null);
        } else {
          str = formatValue(ctx, desc.value, recurseTimes - 1);
        }
        if (str.indexOf('\n') > -1) {
          if (array) {
            str = str.split('\n').map(function(line) {
              return '  ' + line;
            }).join('\n').substr(2);
          } else {
            str = '\n' + str.split('\n').map(function(line) {
              return '   ' + line;
            }).join('\n');
          }
        }
      } else {
        str = ctx.stylize('[Circular]', 'special');
      }
    }
    if (isUndefined(name)) {
      if (array && key.match(/^\d+$/)) {
        return str;
      }
      name = JSON.stringify('' + key);
      if (name.match(/^"([a-zA-Z_][a-zA-Z_0-9]*)"$/)) {
        name = name.substr(1, name.length - 2);
        name = ctx.stylize(name, 'name');
      } else {
        name = name.replace(/'/g, "\\'")
                   .replace(/\\"/g, '"')
                   .replace(/(^"|"$)/g, "'");
        name = ctx.stylize(name, 'string');
      }
    }

    return name + ': ' + str;
  }


  function reduceToSingleString(output, base, braces) {
    var numLinesEst = 0;
    var length = output.reduce(function(prev, cur) {
      numLinesEst++;
      if (cur.indexOf('\n') >= 0) numLinesEst++;
      return prev + cur.replace(/\u001b\[\d\d?m/g, '').length + 1;
    }, 0);

    if (length > 60) {
      return braces[0] +
             (base === '' ? '' : base + '\n ') +
             ' ' +
             output.join(',\n  ') +
             ' ' +
             braces[1];
    }

    return braces[0] + base + ' ' + output.join(', ') + ' ' + braces[1];
  }


  // NOTE: These type checking functions intentionally don't use `instanceof`
  // because it is fragile and can be easily faked with `Object.create()`.
  function isArray(ar) {
    return Array.isArray(ar);
  }
  exports.isArray = isArray;

  function isBoolean(arg) {
    return typeof arg === 'boolean';
  }
  exports.isBoolean = isBoolean;

  function isNull(arg) {
    return arg === null;
  }
  exports.isNull = isNull;

  function isNullOrUndefined(arg) {
    return arg == null;
  }
  exports.isNullOrUndefined = isNullOrUndefined;

  function isNumber(arg) {
    return typeof arg === 'number';
  }
  exports.isNumber = isNumber;

  function isString(arg) {
    return typeof arg === 'string';
  }
  exports.isString = isString;

  function isSymbol(arg) {
    return typeof arg === 'symbol';
  }
  exports.isSymbol = isSymbol;

  function isUndefined(arg) {
    return arg === void 0;
  }
  exports.isUndefined = isUndefined;

  function isRegExp(re) {
    return isObject(re) && objectToString(re) === '[object RegExp]';
  }
  exports.isRegExp = isRegExp;

  function isObject(arg) {
    return typeof arg === 'object' && arg !== null;
  }
  exports.isObject = isObject;

  function isDate(d) {
    return isObject(d) && objectToString(d) === '[object Date]';
  }
  exports.isDate = isDate;

  function isError(e) {
    return isObject(e) &&
        (objectToString(e) === '[object Error]' || e instanceof Error);
  }
  exports.isError = isError;

  function isFunction(arg) {
    return typeof arg === 'function';
  }
  exports.isFunction = isFunction;

  function isPrimitive(arg) {
    return arg === null ||
           typeof arg === 'boolean' ||
           typeof arg === 'number' ||
           typeof arg === 'string' ||
           typeof arg === 'symbol' ||  // ES6 symbol
           typeof arg === 'undefined';
  }
  exports.isPrimitive = isPrimitive;

  exports.isBuffer = require('./support/isBuffer');

  function objectToString(o) {
    return Object.prototype.toString.call(o);
  }


  function pad(n) {
    return n < 10 ? '0' + n.toString(10) : n.toString(10);
  }


  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
                'Oct', 'Nov', 'Dec'];

  // 26 Feb 16:19:34
  function timestamp() {
    var d = new Date();
    var time = [pad(d.getHours()),
                pad(d.getMinutes()),
                pad(d.getSeconds())].join(':');
    return [d.getDate(), months[d.getMonth()], time].join(' ');
  }


  // log is just a thin wrapper to console.log that prepends a timestamp
  exports.log = function() {
    console.log('%s - %s', timestamp(), exports.format.apply(exports, arguments));
  };


  /**
   * Inherit the prototype methods from one constructor into another.
   *
   * The Function.prototype.inherits from lang.js rewritten as a standalone
   * function (not on Function.prototype). NOTE: If this file is to be loaded
   * during bootstrapping this function needs to be rewritten using some native
   * functions as prototype setup using normal JavaScript does not work as
   * expected during bootstrapping (see mirror.js in r114903).
   *
   * @param {function} ctor Constructor function which needs to inherit the
   *     prototype.
   * @param {function} superCtor Constructor function to inherit prototype from.
   */
  exports.inherits = require('inherits');

  exports._extend = function(origin, add) {
    // Don't do anything if add isn't an object
    if (!add || !isObject(add)) return origin;

    var keys = Object.keys(add);
    var i = keys.length;
    while (i--) {
      origin[keys[i]] = add[keys[i]];
    }
    return origin;
  };

  function hasOwnProperty(obj, prop) {
    return Object.prototype.hasOwnProperty.call(obj, prop);
  }

  }).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
  },{"./support/isBuffer":43,"_process":42,"inherits":41}],45:[function(require,module,exports){
  (function (global){
  /** @namespace Twilio */
  var component = require('../lib');
  var componentName = 'TaskRouter';

  /* @license

  The following license applies to all parts of this software except as
  documented below.

      Copyright (c) 2015, Twilio, inc.
      All rights reserved.

      Redistribution and use in source and binary forms, with or without
      modification, are permitted provided that the following conditions are
      met:

        1. Redistributions of source code must retain the above copyright
           notice, this list of conditions and the following disclaimer.

        2. Redistributions in binary form must reproduce the above copyright
           notice, this list of conditions and the following disclaimer in
           the documentation and/or other materials provided with the
           distribution.

        3. Neither the name of Twilio nor the names of its contributors may
           be used to endorse or promote products derived from this software
           without specific prior written permission.

      THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
      "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
      LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
      A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
      HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
      SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
      LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
      DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
      THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
      (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
      OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

  This software includes buffer.js under the following license.

      Copyright (c) 2014 Junction Networks, Inc. <http://www.onsip.com>

      License: The MIT License

      Permission is hereby granted, free of charge, to any person obtaining
      a copy of this software and associated documentation files (the
      "Software"), to deal in the Software without restriction, including
      without limitation the rights to use, copy, modify, merge, publish,
      distribute, sublicense, and/or sell copies of the Software, and to
      permit persons to whom the Software is furnished to do so, subject to
      the following conditions:

      The above copyright notice and this permission notice shall be
      included in all copies or substantial portions of the Software.

      THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
      EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
      MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
      NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
      LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
      OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
      WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
  */

  // Uses CommonJS, AMD or browser globals to create a
  // module using UMD (Universal Module Definition).
  (function (root) {
    // AMD (Requirejs etc)
    if (typeof define === 'function' && define.amd) {
      define([], function() { return component; });
    // Browser globals
    } else {
      root.Twilio = root.Twilio || function Twilio() { };
      root.Twilio[componentName] = component;
    }
  })(window || global || this);


  }).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
  },{"../lib":9}]},{},[45]);
