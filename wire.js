/**
 * @license Copyright (c) 2010 Brian Cavalier
 * LICENSE: see the LICENSE.txt file. If file is missing, this file is subject
 * to the MIT License at: http://www.opensource.org/licenses/mit-license.php.
 */

//
// TODO:
// - Allow easier loading of modules that don't actually need to be references, like dijits that
//    might be used for data-dojo-type
//
(function(global, undef){
	"use strict";

	var VERSION = "0.1",
		wirePrefix = 'wire$',
		tos = Object.prototype.toString,
		arrt = '[object Array]',
		doc = global.document,
		head = doc.getElementsByTagName('head')[0],
		scripts = doc.getElementsByTagName('script'),
		// Hook up to require
		loadModules = global['require'],
		getLoadedModule = loadModules, // this may be requirejs specific
		onDomReady = loadModules.ready, // this is requirejs specific
		rootSpec = global.wire || {},
		defaultModules = ['wire/base'],
		rootContext;
		
	/*
	 * Helpers
	 */
	
	/*
		Function: isArray
		Standard array test
		
		Parameters:
			it - anything
			
		Returns:
		true iff it is an Array
	*/
	function isArray(it) {
		return tos.call(it) === '[object Array]';
	}

	/*
		Function: isFunction
		Standard function test
		
		Parameters:
			it - anything
			
		Returns:
		true iff it is a Function
	*/
	function isFunction(it) {
		return typeof it == 'function';
	}
	
	/*
		Function: keys
		Creates an array of the supplied objects own property names
		
		Parameters:
			obj - Object
			
		Returns:
		Array of obj's own (via hasOwnProperty) property names.
	*/
	function keys(obj) {
		var k = [];
		for(var p in obj) {
			if(obj.hasOwnProperty(p)) {
				k.push(p);
			}
		}
		
		return k;
	}
	
	/*
		Function: getModule
		If spec is a module, gets the value of the module property (usually an AMD module id)
		
		Parameters:
			spec - any wiring spec
			
		Returns:
		the value of the module property, or undefined if the supplied spec
		is not a module.
	*/
	function getModule(spec) {
		return spec.create
			? (typeof spec.create == 'string' ? spec.create : spec.create.module)
			: spec.module;
	}
	
	/*
		Function: isRef
		Determines if the supplied spec is a reference
		
		Parameters:
			spec - any wiring spec
			
		Returns:
		true iff spec is a reference, false otherwise.
	*/
	function isRef(spec) {
		return spec && spec.$ref !== undef;
	}
	
	/*
		Constructor: F
		Constructor used to beget objects that wire needs to create using new.
		
		Parameters:
			ctor - real constructor to be invoked
			args - arguments to be supplied to ctor
	*/
	function F(ctor, args) {
		return ctor.apply(this, args);
	};

	/*
		Function: instantiate
		Creates an object by either invoking ctor as a function and returning the
		result, or by calling new ctor().  It uses a simple heuristic to try to
		guess which approach is the "right" one.
		
		Parameters:
			ctor - function or constructor to invoke
			args - array of arguments to pass to ctor in either case
			
		Returns:
		The result of invoking ctor with args, with or without new, depending on
		the strategy selected.
	*/
	function instantiate(ctor, args) {
		
		if(isConstructor(ctor)) {
			F.prototype = ctor.prototype;
			F.prototype.constructor = ctor;
			return new F(ctor, args);
		} else {
			return ctor.apply(null, args);
		}
	}
	
	/*
		Function: isConstructor
		Determines with the supplied function should be invoked directly or
		should be invoked using new in order to create the object to be wired.
		
		Parameters:
			func - determine whether this should be called using new or not
			
		Returns:
		true iff func should be invoked using new, false otherwise.
	*/
	function isConstructor(func) {
		var is = false, p;
		for(p in func.prototype) {
			if(p !== undef) {
				is = true;
				break;
			}
		}
		
		return is;
	}
	
	/*
		Function: createResolver
		Creates a function to used as a promise resolver, that will resolve another, supplied
		promise if remaining === 0.
		
		Parameters:
			remaining - if remaining === 0, the supplied promise will be resolved with object as the result
			object - object[prop] will be assigned the result of the outer promise, and will be passed
			         to the supplied promise as the resolution
			prop - object[prop] will be assigned the result of the outer promise
			promise - promise to be resolved with object if remaining === 0
			
		Returns:
		A resolution function for a promise
	*/
	function createResolver(remaining, object, prop, promise) {
		return function resolver(result) {
			object[prop] = result;
			if(remaining == 0) {
				promise.resolve(object);
			}
		};
	}
	
	/*
		Function: processFuncList
		Resolves list to 1 or more functions of target, and invokes callback
		for each function.
		
		Parameters:
			list - String function name, or array of string function names
			target - Object having the function or array of functions in list
			spec - wiring spec used to create target
			callback - function to be invoked for each function name in list
			
		Returns:
		A <Promise>
	*/
	function processFuncList(list, target, spec, callback) {
		var func,
			p = new Promise();
			
		if(typeof list == "string") {
			func = target[list];
			if(isFunction(func)) {
				callback(target, spec, func, []);
				p.resolve(target);
			} else {
				p.reject(target);
			}
			
		} else {
			var k = keys(list),
				count = k.length;
				
			for(var f in list) {
				func = target[f];
				if(isFunction(func)) {
					callback(target, spec, func, list[f]);
				}
			}
			
			p.resolve(target);
		}
		
		return p;
	}
	
	/*
		Class: Context
		A Context is the result of wiring a spec.  It will contain all the fully
		realized objects, plus its own wire(), resolve(), and destroy() functions.
	*/
	var Context = function() {};
	
	/*
		Class: ContextFactory
	*/
	/*
		Constructor: contextFactory
	*/
	function contextFactory(parent) {
		return (function(parent) {
			// Use the prototype chain for context parent-child
			// relationships
			Context.prototype = parent ? parent.context : undef;
			var context = new Context(),
				uniqueModuleNames = {},
				// Top-level promises
				modulesReady = new Promise(),
				// objectsCreated = new Promise(),
				objectsReady = new Promise(),
				contextReady = new Promise(),
				contextDestroyed = new Promise(),
				domReady = new Promise(),
				objectDefs = {},
				// Plugins
				setters = [],
				resolvers = {},
				listeners = {
					onContextInit: [],
					onContextError: [],
					onContextReady: [],
					onContextDestroy: [],
					onCreate: [],
					onProperties: [],
					onInit: [],
					onDestroy: []
				},
				// Proxy of this factory that can safely be passed to plugins
				pluginProxy = {
					modulesReady: safe(modulesReady),
					objectsReady: safe(objectsReady),
					domReady: safe(domReady),
					contextDestroyed: safe(contextDestroyed),
					resolveName: function(name) {
						return context[name];
					},
					resolveRef: function(ref) {
						return resolveRef(ref);
					},
					setProperties: function(object, props) {
						return setProperties(object, props);
					},
					refReady: function(name) {
						return objectDefs[name];
					},
					addDestroy: function(destroyFunc) {
						destroyers.push(destroyFunc);
					}
				},
				// Track destroy functions to be called when context is destroyed
				destroyers = [],
				// Counters for objects to create and init so that promises
				// can be resolved when all are complete
				objectsToCreate = 0,
				objectCreateCount = 0,
				objectsToInit = 0,
				objectInitCount = 0;

			
			// Mixin default modules
			for(var i=0; i<defaultModules.length; i++) {
				uniqueModuleNames[defaultModules[i]] = 1;
			}
			
			function resolveRefObj(refObj, promise) {
				var ref = refObj.$ref,
					prefix = "_",
					name = ref;
					
				if(ref.indexOf("!") >= 0) {
					var parts = ref.split("!");
					prefix = parts[0];
				    name = parts[1];
				}

				var promiseProxy = {
					resolve: function resolvePromise(resolved) {
						promise.resolve(resolved);
					}
				};

				promiseProxy.unresolved = (parent)
					? function tryParent() {
						parent.resolveRefObj(refObj, promise);
					}
					: function rejectPromise() {
						promise.reject("Can't resolve reference " + name);
					};

				if(resolvers[prefix]) {
					resolvers[prefix](pluginProxy, name, refObj, promiseProxy);

				} else {
					promiseProxy.unresolved();

				}
			}

			function resolveRef(ref) {
				var p = new Promise();

				if(isRef(ref)) {
					modulesReady.then(function resolveRefAfterModulesReady() {
						resolveRefObj(ref, p);
					});
				} else {
					p.resolve(ref);
				}
				return p;
			}

			function createObject(spec, module) {
				var p = new Promise(),
					object = module;

				function objectCreated(obj, promise) {
					modulesReady.then(function handleModulesReady() {
						contextReady.progress({ object: obj, spec: spec });
						promise.resolve(obj);
					});
				}

				try {
					if(spec.create && isFunction(module)) {
						var args = [];
						if(typeof spec.create == 'object' && spec.create.args) {
							args = isArray(spec.create.args) ? spec.create.args : [spec.create.args];
						}

						parse(args).then(
							function handleCreateParsed(resolvedArgs) {
								objectCreated(instantiate(module, resolvedArgs), p);
							},
							reject(p)
						);
					} else {
						objectCreated(object, p);
					}

				} catch(e) {
					p.reject(e);
				}

				return p;
			}

			function initObject(spec, object) {
				var promise = new Promise();

				function resolveObjectInit() {
					if(spec.init) {
						processFuncList(spec.init, object, spec,
							function handleProcessFuncList(target, spec, func, args) {
								callInit(target, spec, func, args);
							}
						).then(
							function() {
								promise.resolve(object);
							}
						);
					} else {
						promise.resolve(object);
					}
				}

				if(spec.properties) {
					setProperties(object, spec.properties).then(
						resolveObjectInit,
						reject(promise)
					);
				} else {
					resolveObjectInit();
				}


				if(spec.destroy) {
					destroyers.push(function doDestroy() {
						processFuncList(spec.destroy, object, spec, function(target, spec, func, args) {
							func.apply(target, []); // no args for destroy
						});
					});
				}

				return promise;
			}

			function setProperties(object, props) {
				var promise = new Promise(),
					keyArr = keys(props),
					cachedSetter;

				var count = keyArr.length;
				for(var i=0; i<keyArr.length; i++) {
					var name = keyArr[i];
					(function(name, prop) {
						parse(prop).then(function handlePropertiesParsed(value) {
							// If we previously found a working setter for this target, use it
							if(!(cachedSetter && cachedSetter(object, name, value))) {
								var success = false,
									s = 0;

								// Try all the registered setters until we find one that reports success
								while(!success && s<setters.length) {
									var setter = setters[s++];
									success = setter(object, name, value);
									if(success) {
										cachedSetter = setter;
									}
								}
							}

							if(--count === 0) {
								fireEvent('onProperties', object, props);
								promise.resolve(object);
							}
						}, reject(promise));
					})(name, props[name]);
				}

				return promise;
			}

			function callInit(target, spec, func, args) {
				return parse(args).then(function handleInitParsed(processedArgs) {
					func.apply(target, isArray(processedArgs) ? processedArgs : [processedArgs]);
					fireEvent('onInit', target, spec);
				});
			}

			function loadModule(moduleId) {

				var p = uniqueModuleNames[moduleId];

				if(!p) {
					p = uniqueModuleNames[moduleId] = new Promise();
					loadModules([moduleId], function handleModulesLoaded(module) {
						p.resolve(module);
					});
				}

				return p;
			}

			function scanPlugins(modules) {
				var p = new Promise();

				for (var i=0; i < modules.length; i++) {
					var newPlugin = modules[i];
					// console.log("scanning for plugins: " + newPlugin);
					if(typeof newPlugin == 'object') {
						if(newPlugin.wire$resolvers) {
							for(var name in newPlugin.wire$resolvers) {
								resolvers[name] = newPlugin.wire$resolvers[name];
							}
						}

						if(newPlugin.wire$setters) {
							setters = newPlugin.wire$setters.concat(setters);
						}

						if(newPlugin.wire$listeners) {
							addEventListeners(newPlugin.wire$listeners);
						}

						if(isFunction(newPlugin.wire$init)) {
							// Have to init plugins immediately, so they can be used during wiring
							newPlugin.wire$init();
						}
					}
				}

				p.resolve(modules);
				return p;
			}

			function addEventListeners(listener) {
				for(var p in listeners) {
					if(isFunction(listener[p])) {
						listeners[p].push(listener);
					}
				}
			}

			function fireEvent(/* name, arg1, arg2... */) {
				var args = Array.prototype.slice.call(arguments),
					name = args.shift(),
					pluginsToCall = listeners[name];

				for(var i=0; i<pluginsToCall.length; i++) {
					var plugin = pluginsToCall[i];
					plugin[name].apply(plugin, args);
				}
			}

			function initPromiseStages() {
				function rejectPromise(promise, message, err) {
					fireEvent('onContextError', context, message, err);
					reject(promise);
				};

				onDomReady(function resolveDomReady() {
					// console.log('domReady');
					domReady.resolve();
				});

				modulesReady.then(
					function resolveModulesReady(modules) {
						fireEvent('onContextInit', modules);
					},
					function rejectModulesReady(err) {
						// rejectPromise(objectsCreated, "Module loading failed", err);
						rejectPromise(contextReady, "Module loading failed", err);
					});

				contextReady.then(
					function resolveContextReady(context) {
						fireEvent('onContextReady', context);
					},
					null,
					function progressObjectsCreated(status) {
						fireEvent("onCreate", pluginProxy, status.object, status.spec);
					}
				);
			}

			function initFromParent(parent) {
				parent.contextDestroyed.then(function handleParentDestroyed() { destroy(); });
			}

			function parseArray(spec) {
				var processed = [],
					promise = new Promise(),
					len = spec.length;
					
				if(len == 0) {
					promise.resolve(processed);
				}

				var arrCount = len;
				for(var i=0; i<len; i++) {
					parse(spec[i]).then(
						createResolver(--arrCount, processed, i, promise),
						reject(promise));
				}
				
				return promise;
			}

			function parseModule(spec, moduleToLoad) {
				var promise = new Promise();
				
				objectsToInit++;
				// Create object from module
				
				// FIXME: This is a nasty mess right here, kids.  This needs to be
				// factored to reduce the nesting and make it clearer what is happening.
				loadModule(moduleToLoad).then(
					function handleModuleLoaded(module) {
						
						createObject(spec, module).then(
							function handleObjectCreated(created) {
						
								initObject(spec, created).then(
									function handleObjectInited(object) {
						
										promise.resolve(created);
										if(++objectInitCount === objectsToInit) {
											domReady.then(function() {
												objectsReady.resolve(context);
											});
										}
									}
								);
							},
							reject(contextReady)
						);
					}
				);
				
				return promise;
			}
			
			function parseObject(spec, container) {
				var processed = container || {},
					promise = new Promise(),
					props = keys(spec),
					len = props.length;
					
				if(len == 0) {
					promise.resolve(processed);
				} else {
					var propCount = len;
					for(var j=0; j<len; j++) {
						var p = props[j],
							propPromise = parse(spec[p]);

						propPromise.then(
							createResolver(--propCount, processed, p, promise),
							reject(promise)
						);

						if(container && p !== undef && !objectDefs[p]) {
							objectDefs[p] = propPromise;
						}
					}
				}
				
				return promise;
			}
			
			function parse(spec, container) {
				var promise;

				if(isArray(spec)) {
					// Array
					promise = parseArray(spec);

				} else if(typeof spec == 'object') {
					// module, reference, or simple object

					var moduleToLoad = getModule(spec);
					
					if(moduleToLoad) {
						// Module
						promise = parseModule(spec, moduleToLoad);

					} else if(isRef(spec)) {
						// Reference
						promise = resolveRef(spec);

					} else {
						// Simple object
						promise = parseObject(spec, container);
					}

				} else {
					// Integral value/basic type, e.g. String, Number, Boolean, Date, etc.
					promise = new Promise();
					promise.resolve(spec);
				}

				return promise;
			}

			/*
				Function: finalizeContext
				Adds public functions to the supplied context and uses it to resolve the
				contextReady promise.
				
				Parameters:
					parsedContext - <Context> to finalize and use as resolution for contextReady
			*/
			function finalizeContext(parsedContext) {
				/*
					Class: Context
				*/
				/*
					Function: wire
					Wires a new child <Context> from this <Context>
					
					Parameters:
						spec - wiring spec
						
					Returns:
					a <Promise> that will be resolved when the new child <Context> has
					been wired.
				*/
				parsedContext.wire = function wire(spec) {
					var newParent = {
						wire: wire,
						context: context,
						resolveRefObj: resolveRefObj,
						contextDestroyed: contextDestroyed
					};
					return safe(contextFactory(newParent).wire(spec));
				};

				/*
					Function: resolve
					Resolves references using this <Context>.  This will cascade up to ancestor <Context>s
					until the reference is either resolved or the root <Context> has been reached without
					resolution, at which point the returned <Promise> will be rejected.
					
					Parameters:
						ref - reference name (String) to resolve
						
					Returns:
					a <Promise> that will be resolved when the reference has been resolved or rejected
					if the reference cannot be resolved.
				*/
				parsedContext.resolve = function resolve(ref) {
					return safe(resolveName(ref));
				};
				
				/*
					Function: destroy
					Destroys this <Context> *and all of its descendents*.
					
					Returns:
					a <Promise> that will be resolved when this <Context> has been destroyed.
				*/
				parsedContext.destroy = function destroyContext() {
					return safe(destroy());
				};

				if(objectsToInit === 0 && !objectsReady.completed) {
					objectsReady.resolve(parsedContext);
				}

				objectsReady.then(function finalizeContextReady(readyContext) {
					// TODO: Remove explicit domReady wait
					// It should be possible not to have to wait for domReady
					// here, but rely on promise resolution.  For now, just wait
					// for it.
					domReady.then(function() {
						contextReady.resolve(readyContext);
					});
				});
			}

			/*
				Class: ContextFactory
			*/
			/*
				Function: wire
				
			*/
			function wire(spec) {
				initPromiseStages();
				
				if(parent) {
					initFromParent(parent);
				}

				try {
					parse(spec, context).then(
						finalizeContext,
						reject(contextReady)
					);

					loadModules(keys(uniqueModuleNames), function handleModulesLoaded() {
						scanPlugins(arguments).then(function handlePluginsScanned(scanned) {
							modulesReady.resolve(scanned);
						});
					});

				} catch(e) {
					contextReady.reject(e);
				}

				return contextReady;
			}
			
			function destroy() {
				function doDestroy() {
					for(var i=0; i < destroyers.length; i++) {
						try {
							destroyers[i]();
						} catch(e) {
							/* squelch? */
							console.log(e);
						}
					}

					fireEvent('onContextDestroy', context);
					contextDestroyed.resolve();
				}
				contextReady.then(doDestroy, doDestroy);

				return contextDestroyed;
			}
			
			return {
				wire: wire
			};
		})(parent);
	}
	
	function safe(promise) {
		return {
			then: function safeThen(resolve, reject, progress) {
				return promise.then(resolve, reject, progress);
			}
		};
	}
	
	function reject(promise) {
		return function(err) {
			promise.reject(err);
		};
	}
	
	/*
		Class: Promise
	*/
	/*
		Constructor: Promise
		Promise implementation based on unscriptable's minimalist Promise:
		https://gist.github.com/814052/
		with safe mod and progress by me:
		https://gist.github.com/814313
	*/ 
	
	function Promise () {
		this._thens = [];
	}

	Promise.prototype = {

		/* This is the "front end" API. */

		// then(onResolve, onReject): Code waiting for this promise uses the
		// then() method to be notified when the promise is complete. There
		// are two completion callbacks: onReject and onResolve. A more
		// robust promise implementation will also have an onProgress handler.
		then: function (onResolve, onReject, onProgress) {
			// capture calls to then()
			this._thens.push({ resolve: onResolve, reject: onReject, progress: onProgress });
		},

		// Some promise implementations also have a cancel() front end API that
		// calls all of the onReject() callbacks (aka a "cancelable promise").
		// cancel: function (reason) {},

		/* This is the "back end" API. */

		// resolve(resolvedValue): The resolve() method is called when a promise
		// is resolved (duh). The resolved value (if any) is passed by the resolver
		// to this method. All waiting onResolve callbacks are called
		// and any future ones are, too, each being passed the resolved value.
		resolve: function (val) { this._complete('resolve', val); },

		// reject(exception): The reject() method is called when a promise cannot
		// be resolved. Typically, you'd pass an exception as the single parameter,
		// but any other argument, including none at all, is acceptable.
		// All waiting and all future onReject callbacks are called when reject()
		// is called and are passed the exception parameter.
		reject: function (ex) { this._complete('reject', ex); },

		// Some promises may have a progress handler. The back end API to signal a
		// progress "event" has a single parameter. The contents of this parameter
		// could be just about anything and is specific to your implementation.
		// progress: function (data) {},
		
		progress: function(statusObject) {
			var i=0,
				aThen;
			while(aThen = this._thens[i++]) { aThen.progress && aThen.progress(statusObject); }
		},

		/* "Private" methods. */

		_complete: function (which, arg) {
			// switch over to sync then()
			this.then = which === 'reject' ?
				function (resolve, reject) { reject && reject(arg); } :
				function (resolve, reject) { resolve && resolve(arg); };

			// disallow multiple calls to resolve or reject
			this.resolve = this.reject = this.progress =
				function () { throw new Error('Promise already completed.'); };

			// complete all waiting (async) then()s
			var aThen,
				i = 0;
			while (aThen = this._thens[i++]) { aThen[which] && aThen[which](arg); }
			delete this._thens;
		}
	};
	
	
	/*
		Function: wire
		Global wire function that is the starting point for wiring applications.
		
		Parameters:
			spec - wiring spec
			ready - Function to call with the newly wired Context
	*/
	var w = global['wire'] = function wire(spec) { // global['wire'] for closure compiler export
		var promise;
		if(rootContext === undef) {
			// No root context yet, so wire it first, then wire the requested spec as
			// a child.  Subsequent wire() calls will reuse the existing root context.
			promise = new Promise();
			
			contextFactory().wire(rootSpec).then(function(context) {
				rootContext = context;
				rootContext.wire(spec).then(
					function(context) {
						promise.resolve(context);
					},
					function(err) {
						promise.reject(err);
					}
				);
			});
		} else {
			promise = rootContext.wire(spec);
		}
		
		return safe(promise); // Return restricted promise
	};
	
	w.version = VERSION;
	
	// WARNING: Probably unsafe. Just for testing right now.
	// TODO: Only do this for browser env
	
	// Find our script tag and look for data attrs
	for(var i=0; i<scripts.length; i++) {
		var script = scripts[i],
			src = script.src,
			specUrl;
		
		// if(/wire[^\/]*\.js(\W|$)/.test(src) && (specUrl = script.getAttribute('data-wire-spec'))) {
		if((specUrl = script.getAttribute('data-wire-spec'))) {
			loadModules([specUrl]);
			// // Use a script tag to load the wiring spec
			// var specScript = doc.createElement('script');
			// specScript.src = specUrl;
			// head.appendChild(specScript);
		}
	}

})(window);
