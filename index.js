var buildDictionary = require('sails-build-dictionary');
var path = require('path');
var uuid = require('node-uuid');
module.exports = function(sails) {

  return {

    mountMap: {},

    apps: {},

    defaults: {
      paths: {
        subapps: path.resolve(sails.config.appPath, 'subapps')
      },
      __configKey__: {}
    },

    configure: function() {

      var self = this;

      // Set up HTTP middleware
      sails.config.http.middleware.subApps = function(req, res, next) {
        // See if the url matches any of the mount points
        if (!sails.util.any(self.mountMap, function(app, url) {
          var regex = new RegExp("^"+url+"($|\\/)");
          if (req.url.match(regex)) {
            req.originalUrl = req.url = req.url.replace(regex,'/');
            app.hooks.http.server.emit('request', req, res);
            return true;
          }
        })) 
        // Otherwise continue trying to match the route in the parent app
        {
          return next();
        }
      };

      // Add HTTP middleware to the load order array
      var bodyParserIndex = sails.config.http.middleware.order.indexOf('bodyParser');
      sails.config.http.middleware.order.splice(bodyParserIndex, 0, 'subApps');

      // Wrap the default virtual router
      var defaultRouter = sails.router.route;
      sails.router.route = function(req, res) {
        // See if the url matches any of the mount points
        if (!sails.util.any(self.mountMap, function(app, url) {
          var regex = new RegExp("^"+url+"($|\\/)");
          if (req.url.match(regex)) {
            req.originalUrl = req.url = req.url.replace(regex,'/');
            app.router.route(req, res);
            return true;
          }
        })) 
        // Otherwise continue with the parent virtual router
        {
          return defaultRouter(req, res);
        }
      };

      // Make sure all the adapters are forced to load
      _.each(sails.config[self.configKey], function(subappConfig) {
        if (subappConfig.connections) {
          _.each(subappConfig.connections, function(connection) {
            if (sails.config.connections[connection]) {
              sails.config.connections[connection].forceLoadAdapter = true;
            }
          });
        }
      });



    },

    /**
     * Load subapps
     *
     * @param {Object} options
     * @param {Function} cb
     */
    loadSubapps: function (cb) {
      async.auto({

        // Load apps from the "subapps" folder
        subappsFolder: function(cb) {
          buildDictionary.optional({
            dirname: sails.config.paths.subapps,
            filter: /^(package\.json)$/,
            depth: 2
          }, cb);
        },

        // Load apps from node_modules
        nodeModulesFolder: function(cb) {
          buildDictionary.optional({
            dirname: path.resolve(sails.config.appPath, "node_modules"),
            filter: /^(package\.json)$/,
            depth: 2
          }, cb);
        }
      }, function(err, results) {
        if (err) {return cb(err);}

        // Marshall the subapps by checking that they are valid and adding an "appPath"
        // to each module definition
        var subapps = {};

        // Apps loaded from the "subapps" folder don't need the "isSubapp" flag
        subapps = _.reduce(results.subappsFolder, function(memo, module, identity) {
          module.appPath = path.resolve(sails.config.paths.subapps, identity);
          memo[identity] = module;
          return memo;
        }, {});

        // Apps loaded from "node_modules" need to have "sails.isSubapp: true" in order for us
        // to know that they are a sails app
        _.extend(subapps, _.reduce(results.nodeModulesFolder, function(memo, module, identity) {
          if (module['package.json'] && module['package.json'].sails && module['package.json'].sails.isSubapp) {
            module.appPath = path.resolve(sails.config.appPath, "node_modules", identity);
            memo[identity] = module;
          }
          return memo;
        }, {}));
        cb(null, subapps);
      });
    },

    initialize: function(cb) {

      var self = this;
      var eventsToWaitFor = [];
      if (sails.hooks.orm) {
        eventsToWaitFor.push('hook:orm:loaded');
      }
      sails.after(eventsToWaitFor, function() {
        self.loadSubapps(function modulesLoaded (err, modules) {
          if (err) return cb(err);

          // Loop through each subapp
          async.each(sails.util.keys(modules), function(identity, cb) {

            // Get the module definition
            var module = modules[identity];

            // Get the app's package.json
            var packageJson = module['package.json'];

            // Get any user-level subapp config
            var config = (sails.config[self.configKey] && sails.config[self.configKey][identity]) || {};

            // Load the app
            var app = new sails.constructor();

            app.adapters = sails.adapters;

            var mappedConnections = _.reduce(config.connections, function(memo, val, key) {
              // Create a unique ID for this connection to guarantee that it won't
              // collide with other, already-registered connections
              var connectionId = uuid.v4();
              if (typeof val == 'string') {
                memo[connectionId] = _.cloneDeep(sails.config.connections[val]);
              } else {
                memo[connectionId] = _.cloneDeep(val);
              }
              memo[connectionId].mappedFrom = key;
              return memo;
            }, {localDiskDb: false});

            // User-level config for the subapp
            // This config will be merged into the subapp's sails.config
            config.config = config.config || {};

            // Set the user-level mount config
            // The subapp may use this for paths to static assets
            config.config.mount = (config.mount || (packageJson.sails && packageJson.sails.mount) || '/' + (packageJson.name));

            // Load the Sails app for the subapp, using the ".config" object of thr subapp config
            // if any, extended with some important configuration properties of our own.
            app.load(_.extend({}, config.config, {
              appPath: module.appPath,
              // Subapps can't merge vars into globals--must use this.sails.models, this.sails.services, etc.
              globals: false,
              // Subapps can't use grunt (yet)
              hooks: {
                grunt: false
              },
              // Mark this as a subApp so it knows its place
              isSubApp: true,

              // Override the module loader to alter the model connections
              moduleLoaderOverride: function(sails, moduleLoader) {
                var defaultModelLoader = moduleLoader.loadModels;
                return {
                  loadModels: function(cb) {
                    defaultModelLoader(function(err, modules) {
                      if (err) {return cb(err);}
                      _.each(modules, function(module) {
                        // Use the default connection if the model doesn't specify one
                        module.connection = module.connection || sails.config.models.connection;
                        // Find which connection this is mapped to 
                        var mappedKey = _.findKey(mappedConnections, function(mappedConnection) {
                          return mappedConnection.mappedFrom == module.connection;
                        });
                        // Set the child app model to use the mapped connection 
                        module.connection = mappedKey;
                      });
                      return cb(null, modules);
                    });
                  }
                };
              },

              connections: mappedConnections,

            }), function(err, loadedApp) {
              if (err) {
                return cb(err);
              }
              // Add a reference to the parent app
              loadedApp.parentApp = sails;

              // Add this sub app to the list of loaded apps
              self.apps[identity] = loadedApp;
              // Get the mount point (i.e. prefix for routes in the sub app)
              var mountConfig = config.mount || (packageJson.sails && packageJson.sails.mount) || '/' + (packageJson.name);
              if (typeof mountConfig == 'string') {
                self.mountMap[mountConfig] = loadedApp;
              } else {
                // Allow more mounting options such as multiple mount points
                // and URL rewrites
              }

              // Function to expose parent models to subapp, and subapp models to parent,
              // based on `models` configuration
              function exposeModels() {
                // Loop through subapp models and expose / map any we've been told to
                _.each(config.models, function(modelConfig, modelId) {

                  // If "modelConfig" is a string, it should be the name of a model in the outer app
                  if (typeof modelConfig == 'string') {
                    // Fail if no such outer app model exists
                    if (!sails.models[modelConfig]) {
                      return cb(new Error("Tried to expose map subapp model `" + modelId +"` to parent app model `" + modelConfig + '`, but no such model exists in the parent app.'));
                    }
                    loadedApp.models[modelId] = sails.models[modelConfig];
                  }

                  // If "modelConfig" is an object with an "expose" key, then expose the subapp's model
                  // in the parent app
                  else if (modelConfig.expose && loadedApp.models[modelId]) {
                    var exposeAs = modelConfig.expose === true ? modelId : modelConfig.expose;
                    if (sails.models[exposeAs]) {
                      cb(new Error("Tried to expose model `" + exposeAs +"` of subapp `" + identity + '`, but a model with that identity already exists.'));
                    }
                    sails.models[exposeAs] = loadedApp.models[modelId];
                  }
                });                
              }

              // Do the initial model configuration
              exposeModels();

              // Remove / replace exposed subapp models during a parent ORM reload.
              // This avoids issues where Waterline attempts to load information about
              // subapp models that it doesn't really know anything about.
              sails.on('hook:orm:reload', function() {
                _.each(config.models, function(modelConfig, modelId) {

                  // Delete exposed models
                  if (modelConfig.expose && loadedApp.models[modelId]) {
                    var exposeAs = modelConfig.expose === true ? modelId : modelConfig.expose;
                    delete sails.models[exposeAs];
                  }
                });                

                // Once the parent ORM is reloaded, re-expose subapp models
                sails.once('hook:orm:reloaded', function() {
                  exposeModels();
                });
              });

              return cb();
            });

          }, cb);
        });
      });
    }

  };

};
