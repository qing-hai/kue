
/*!
 * kue
 * Copyright (c) 2011 LearnBoost <tj@learnboost.com>
 * MIT Licensed
 */

/**
 * Module dependencies.
 */

var EventEmitter = require('events').EventEmitter
  , Worker = require('./queue/worker')
  , events = require('./queue/events')
  , Job = require('./queue/job')
  , redis = require('./redis');

/**
 * Expose `Queue`.
 */

exports = module.exports = Queue;

/**
 * Library version.
 */

exports.version = '0.6.4';

/**
 * Expose `Job`.
 */

exports.Job = Job;

/**
 * Server instance (that is lazily required)
 */

var app;

/**
 * Expose the server.
 */

Object.defineProperty(exports, 'app', {
  get: function() {
    return app || (app = require('./http'));
  }
});

/**
 * Expose the RedisClient factory.
 */

exports.redis = redis;

/**
 * Create a new `Queue`.
 *
 * @return {Queue}
 * @api public
 */

exports.createQueue = function(){
  return Queue.singleton = new Queue;
};

/**
 * Store workers
 */
exports.workers = [];

/**
 * Initialize a new job `Queue`.
 *
 * @api public
 */

function Queue() {
  this.client = redis.createClient();
  this.workers = exports.workers;
}

/**
 * Inherit from `EventEmitter.prototype`.
 */

Queue.prototype.__proto__ = EventEmitter.prototype;

/**
 * Create a `Job` with the given `type` and `data`.
 *
 * @param {String} type
 * @param {Object} data
 * @return {Job}
 * @api public
 */

Queue.prototype.create =
Queue.prototype.createJob = function(type, data){
  return new Job(type, data);
};

/**
 * Proxy to auto-subscribe to events.
 *
 * @api public
 */

var on = EventEmitter.prototype.on;
Queue.prototype.on = function(event){
  if (0 == event.indexOf('job')) events.subscribe();
  return on.apply(this, arguments);
};

/**
 * Promote delayed jobs, checking every `ms`,
 * defaulting to 5 seconds.
 *
 * @params {Number} ms
 * @api public
 */

Queue.prototype.promote = function(ms,l){
  var client = this.client
    , ms = ms || 5000
    , limit = l || 50;

  setInterval(function(){
    client.sort('q:jobs:delayed'
      , 'by', 'q:job:*->delay_plus_created_at'
      , 'get', '#'
      //, 'get', 'q:job:*->delay'
      , 'get', 'q:job:*->delay_plus_created_at'
      , 'limit', 0, limit, function(err, jobs){
      if (err || !jobs.length) return;
	  
	  
	  //if (jobs.length===limit)
	  //console.log("kue promote jobs.length",jobs.length,jobs);

      // iterate jobs with [id, delay, created_at]
      while (jobs.length) {
        var job = jobs.slice(0, 2)
          , id = parseInt(job[0], 10)
		  , delay_plus_created_at = parseInt(job[1], 10);
          //, delay = parseInt(job[1], 10)
          //, creation = parseInt(job[2], 10)`	
		  
		  
		var needClearNonExistingJob=  isNaN(delay_plus_created_at);
        var promote =needClearNonExistingJob?false:! Math.max(delay_plus_created_at - Date.now(), 0);

        // if it's due for activity
        // "promote" the job by marking
        // it as inactive.
        if (promote) {
		  //console.log("kue promotion job",id,new Date(delay_plus_created_at));	
          Job.get(id, function(err, job){
            if (err) return;
            events.emit(job.id, 'promotion');
			//console.log("kue promotion job",job.id,job.type);
            job.inactive();
          });
        };
		if (needClearNonExistingJob){
			client.zrem("q:jobs:delayed", id);
		}

        jobs = jobs.slice(2);
		
      }
    });
  }, ms);
};

/**
 * Get setting `name` and invoke `fn(err, res)`.
 *
 * @param {String} name
 * @param {Function} fn
 * @return {Queue} for chaining
 * @api public
 */

Queue.prototype.setting = function(name, fn){
  this.client.hget('q:settings', name, fn);
  return this;
};

//add by qinghai
function fillUpKueJobsListToInactiveZSet(redis, jobType, callback) {
    redis.multi().llen('q:' + jobType + ':jobs').zcard('q:jobs:' + jobType + ':inactive').exec(function (err, res) {
        if (err) {
            callback();
            return console.error(err);
        }


        var todoJobLen = parseInt(res[0]);
        var inActiveJobLen = parseInt(res[1]);
        if (todoJobLen < inActiveJobLen) {
            var inputParams = ['q:' + jobType + ':jobs'];
            for (var i = todoJobLen; i < inActiveJobLen; i++) {
                inputParams.push(1);
            }

            redis.rpush(inputParams, function (err, res) {
                callback();
            });

            redis.lrange('q:' + jobType + ':jobs', 0, -1, function (err, res) {
                console.log(jobType,"fillUpKueJobsListToInactiveZSet",err, res);
            });
        }
        else
          callback();
    });
}

/**
 * Process jobs with the given `type`, invoking `fn(job)`.
 *
 * @param {String} type
 * @param {Number|Function} n
 * @param {Function} fn
 * @api public
 */

Queue.prototype.process = function(type, n, fn){
  var self = this;

  if ('function' == typeof n) fn = n, n = 1;
  
  fillUpKueJobsListToInactiveZSet(self.client, type, function(){
    while (n--) {
      var worker = new Worker(this, type).start(fn);
  
      worker.on('error', function(err){
        self.emit('error', err);
      });
  
      worker.on('job complete', function(job){
        self.client.incrby('q:stats:work-time', job.duration);
      });
  
      // Save worker so we can access it later
      self.workers.push(worker);
    }
  })
};

/**
 * @Behrad support for shutting down a specific worker type
 *
 * Graceful shutdown
 *
 * @param {Function} fn callback
 * @return {Queue} for chaining
 * @api public
 */

Queue.prototype.shutdown = function(type, fn, timeout) {
  if( !type || !type.split ) {
      timeout = fn;
      fn = type;
      type = '';
  }
  var origFn = fn || function(){}
    , self = this
    , n = self.workers.length;

  // Wrap `fn` to only call after all workers finished
  fn = function(err) {
    if (err) return origFn(err);
    if (! --n) {
//        self.workers = [];
        origFn.apply(null, arguments);
    }
  };
  if (!self.workers.length) origFn();
  // Shut down workers 1 by 1
  self.workers.forEach(function(worker) {
    if( worker.type.indexOf(type) > -1 ) {
        worker.shutdown(fn, timeout);
    } else {
        fn && fn();
    }
  });

  return this;
};

/**
 * Get the job types present and callback `fn(err, types)`.
 *
 * @param {Function} fn
 * @return {Queue} for chaining
 * @api public
 */

Queue.prototype.types = function(fn){
  this.client.smembers('q:job:types', fn);
  return this;
};

/**
 * Return job ids with the given `state`, and callback `fn(err, ids)`.
 *
 * @param {String} state
 * @param {Function} fn
 * @return {Queue} for chaining
 * @api public
 */

Queue.prototype.state = function(state, fn){
  this.client.zrange('q:jobs:' + state, 0, -1, fn);
  return this;
};

/**
 * Get queue work time in milliseconds and invoke `fn(err, ms)`.
 *
 * @param {Function} fn
 * @return {Queue} for chaining
 * @api public
 */

Queue.prototype.workTime = function(fn){
  this.client.get('q:stats:work-time', function(err, n){
    if (err) return fn(err);
    fn(null, parseInt(n, 10));
  });
  return this;
};

/**
 * Get cardinality of `state` and callback `fn(err, n)`.
 *
 * @param {String} state
 * @param {Function} fn
 * @return {Queue} for chaining
 * @api public
 */

Queue.prototype.card = function(state, fn){
  this.client.zcard('q:jobs:' + state, fn);
  return this;
};

/**
 * Completed jobs.
 */

Queue.prototype.complete = function(fn){
  return this.state('complete', fn);
};

/**
 * Failed jobs.
 */

Queue.prototype.failed = function(fn){
  return this.state('failed', fn);
};

/**
 * Inactive jobs (queued).
 */

Queue.prototype.inactive = function(fn){
  return this.state('inactive', fn);
};

/**
 * Active jobs (mid-process).
 */

Queue.prototype.active = function(fn){
  return this.state('active', fn);
};

/**
 * Completed jobs count.
 */

Queue.prototype.completeCount = function(fn){
  return this.card('complete', fn);
};

/**
 * Failed jobs count.
 */

Queue.prototype.failedCount = function(fn){
  return this.card('failed', fn);
};

/**
 * Inactive jobs (queued) count.
 */

Queue.prototype.inactiveCount = function(fn){
  return this.card('inactive', fn);
};

/**
 * Active jobs (mid-process).
 */

Queue.prototype.activeCount = function(fn){
  return this.card('active', fn);
};

/**
 * Delayed jobs.
 */

Queue.prototype.delayedCount = function(fn){
  return this.card('delayed', fn);
};
