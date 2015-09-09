(function (global, undefined) {

// Holds anything kiwi client specific (ie. front, gateway, _kiwi.plugs..)
/**
*   @namespace
*/
var _kiwi = {};

_kiwi.misc = {};
_kiwi.model = {};
_kiwi.view = {};
_kiwi.applets = {};
_kiwi.utils = {};


/**
 * A global container for third party access
 * Will be used to access a limited subset of kiwi functionality
 * and data (think: plugins)
 */
_kiwi.global = {
    build_version: '',  // Kiwi IRC version this is built from (Set from index.html)
    settings: undefined, // Instance of _kiwi.model.DataStore
    plugins: undefined, // Instance of _kiwi.model.PluginManager
    events: undefined, // Instance of PluginInterface
    rpc: undefined, // Instance of WebsocketRpc
    utils: {}, // References to misc. re-usable helpers / functions

    // Make public some internal utils for plugins to make use of
    initUtils: function() {
        this.utils.randomString = randomString;
        this.utils.secondsToTime = secondsToTime;
        this.utils.parseISO8601 = parseISO8601;
        this.utils.escapeRegex = escapeRegex;
        this.utils.formatIRCMsg = formatIRCMsg;
        this.utils.styleText = styleText;
        this.utils.hsl2rgb = hsl2rgb;

        this.utils.notifications = _kiwi.utils.notifications;
        this.utils.formatDate = _kiwi.utils.formatDate;
    },

    addMediaMessageType: function(match, buildHtml) {
        _kiwi.view.MediaMessage.addType(match, buildHtml);
    },

    // Event managers for plugins
    components: {
        EventComponent: function(event_source, proxy_event_name) {
            /*
             * proxyEvent() listens for events then re-triggers them on its own
             * event emitter. Why? So we can .off() on this emitter without
             * effecting the source of events. Handy for plugins that we don't
             * trust meddling with the core events.
             *
             * If listening for 'all' events the arguments are as follows:
             *     1. Name of the triggered event
             *     2. The event data
             * For all other events, we only have one argument:
             *     1. The event data
             *
             * When this is used via `new kiwi.components.Network()`, this listens
             * for 'all' events so the first argument is the event name which is
             * the connection ID. We don't want to re-trigger this event name so
             * we need to juggle the arguments to find the real event name we want
             * to emit.
             */
            function proxyEvent(event_name, event_data) {
                if (proxy_event_name == 'all') {
                } else {
                    event_data = event_name.event_data;
                    event_name = event_name.event_name;
                }

                this.trigger(event_name, event_data);
            }

            // The event we are to proxy
            proxy_event_name = proxy_event_name || 'all';

            _.extend(this, Backbone.Events);
            this._source = event_source;

            // Proxy the events to this dispatcher
            event_source.on(proxy_event_name, proxyEvent, this);

            // Clean up this object
            this.dispose = function () {
                event_source.off(proxy_event_name, proxyEvent);
                this.off();
                delete this.event_source;
            };
        },

        Network: function(connection_id) {
            var connection_event;

            // If no connection id given, use all connections
            if (typeof connection_id !== 'undefined') {
                connection_event = 'connection:' + connection_id.toString();
            } else {
                connection_event = 'connection';
            }

            // Helper to get the network object
            var getNetwork = function() {
                var network = typeof connection_id === 'undefined' ?
                    _kiwi.app.connections.active_connection :
                    _kiwi.app.connections.getByConnectionId(connection_id);

                return network ?
                    network :
                    undefined;
            };

            // Create the return object (events proxy from the gateway)
            var obj = new this.EventComponent(_kiwi.gateway, connection_event);

            // Proxy several gateway functions onto the return object
            var funcs = {
                kiwi: 'kiwi', raw: 'raw', kick: 'kick', topic: 'topic',
                part: 'part', join: 'join', action: 'action', ctcp: 'ctcp',
                ctcpRequest: 'ctcpRequest', ctcpResponse: 'ctcpResponse',
                notice: 'notice', msg: 'privmsg', say: 'privmsg',
                changeNick: 'changeNick', channelInfo: 'channelInfo',
                mode: 'mode', quit: 'quit'
            };

            _.each(funcs, function(gateway_fn, func_name) {
                obj[func_name] = function() {
                    var fn_name = gateway_fn;

                    // Add connection_id to the argument list
                    var args = Array.prototype.slice.call(arguments, 0);
                    args.unshift(connection_id);

                    // Call the gateway function on behalf of this connection
                    return _kiwi.gateway[fn_name].apply(_kiwi.gateway, args);
                };
            });

            // Now for some network related functions...
            obj.createQuery = function(nick) {
                var network, restricted_keys;

                network = getNetwork();
                if (!network) {
                    return;
                }

                return network.createQuery(nick);
            };

            // Add the networks getters/setters
            obj.get = function(name) {
                var network, restricted_keys;

                network = getNetwork();
                if (!network) {
                    return;
                }

                restricted_keys = [
                    'password'
                ];
                if (restricted_keys.indexOf(name) > -1) {
                    return undefined;
                }

                return network.get(name);
            };

            obj.set = function() {
                var network = getNetwork();
                if (!network) {
                    return;
                }

                return network.set.apply(network, arguments);
            };

            return obj;
        },

        ControlInput: function() {
            var obj = new this.EventComponent(_kiwi.app.controlbox);
            var funcs = {
                run: 'processInput', addPluginIcon: 'addPluginIcon'
            };

            _.each(funcs, function(controlbox_fn, func_name) {
                obj[func_name] = function() {
                    var fn_name = controlbox_fn;
                    return _kiwi.app.controlbox[fn_name].apply(_kiwi.app.controlbox, arguments);
                };
            });

            // Give access to the control input textarea
            obj.input = _kiwi.app.controlbox.$('.inp');

            return obj;
        }
    },

    // Entry point to start the kiwi application
    init: function (opts, callback) {
        var locale_promise, theme_promise,
            that = this;

        opts = opts || {};

        this.initUtils();

        // Set up the settings datastore
        _kiwi.global.settings = _kiwi.model.DataStore.instance('kiwi.settings');
        _kiwi.global.settings.load();

        // Set the window title
        window.document.title = opts.server_settings.client.window_title || 'Kiwi IRC';

        locale_promise = new Promise(function (resolve) {
            // In order, find a locale from the users saved settings, the URL, default settings on the server, or auto detect
            var locale = _kiwi.global.settings.get('locale') || opts.locale || opts.server_settings.client.settings.locale || 'magic';
            $.getJSON(opts.base_path + '/assets/locales/' + locale + '.json', function (locale) {
                if (locale) {
                    that.i18n = new Jed(locale);
                } else {
                    that.i18n = new Jed();
                }
                resolve();
            });
        });

        theme_promise = new Promise(function (resolve) {
            var text_theme = opts.server_settings.client.settings.text_theme || 'default';
            $.getJSON(opts.base_path + '/assets/text_themes/' + text_theme + '.json', function(text_theme) {
                opts.text_theme = text_theme;
                resolve();
            });
        });


        Promise.all([locale_promise, theme_promise]).then(function () {
            _kiwi.app = new _kiwi.model.Application(opts);

            // Start the client up
            _kiwi.app.initializeInterfaces();

            // Event emitter to let plugins interface with parts of kiwi
            _kiwi.global.events  = new PluginInterface();

            // Now everything has started up, load the plugin manager for third party plugins
            _kiwi.global.plugins = new _kiwi.model.PluginManager();

            callback();

        }).then(null, function(err) {
            console.error(err.stack);
        });
    },

    start: function() {
        _kiwi.app.showStartup();
    },

    // Allow plugins to change the startup applet
    registerStartupApplet: function(startup_applet_name) {
        _kiwi.app.startup_applet_name = startup_applet_name;
    },

    /**
     * Open a new IRC connection
     * @param {Object} connection_details {nick, host, port, ssl, password, options}
     * @param {Function} callback function(err, network){}
     */
    newIrcConnection: function(connection_details, callback) {
        _kiwi.gateway.newConnection(connection_details, callback);
    },


    /**
     * Taking settings from the server and URL, extract the default server/channel/nick settings
     */
    defaultServerSettings: function () {
        var parts;
        var defaults = {
            nick: '',
            server: '',
            port: 6667,
            ssl: false,
            channel: '',
            channel_key: ''
        };
        var uricheck;


        /**
         * Get any settings set by the server
         * These settings may be changed in the server selection dialog or via URL parameters
         */
        if (_kiwi.app.server_settings.client) {
            if (_kiwi.app.server_settings.client.nick)
                defaults.nick = _kiwi.app.server_settings.client.nick;

            if (_kiwi.app.server_settings.client.server)
                defaults.server = _kiwi.app.server_settings.client.server;

            if (_kiwi.app.server_settings.client.port)
                defaults.port = _kiwi.app.server_settings.client.port;

            if (_kiwi.app.server_settings.client.ssl)
                defaults.ssl = _kiwi.app.server_settings.client.ssl;

            if (_kiwi.app.server_settings.client.channel)
                defaults.channel = _kiwi.app.server_settings.client.channel;

            if (_kiwi.app.server_settings.client.channel_key)
                defaults.channel_key = _kiwi.app.server_settings.client.channel_key;
        }



        /**
         * Get any settings passed in the URL
         * These settings may be changed in the server selection dialog
         */

        // Any query parameters first
        if (getQueryVariable('nick'))
            defaults.nick = getQueryVariable('nick');

        if (window.location.hash)
            defaults.channel = window.location.hash;


        // Process the URL part by part, extracting as we go
        parts = window.location.pathname.toString().replace(_kiwi.app.get('base_path'), '').split('/');

        if (parts.length > 0) {
            parts.shift();

            if (parts.length > 0 && parts[0]) {
                // Check to see if we're dealing with an irc: uri, or whether we need to extract the server/channel info from the HTTP URL path.
                uricheck = parts[0].substr(0, 7).toLowerCase();
                if ((uricheck === 'ircs%3a') || (uricheck.substr(0,6) === 'irc%3a')) {
                    parts[0] = decodeURIComponent(parts[0]);
                    // irc[s]://<host>[:<port>]/[<channel>[?<password>]]
                    uricheck = /^irc(s)?:(?:\/\/?)?([^:\/]+)(?::([0-9]+))?(?:(?:\/)([^\?]*)(?:(?:\?)(.*))?)?$/.exec(parts[0]);
                    /*
                        uricheck[1] = ssl (optional)
                        uricheck[2] = host
                        uricheck[3] = port (optional)
                        uricheck[4] = channel (optional)
                        uricheck[5] = channel key (optional, channel must also be set)
                    */
                    if (uricheck) {
                        if (typeof uricheck[1] !== 'undefined') {
                            defaults.ssl = true;
                            if (defaults.port === 6667) {
                                defaults.port = 6697;
                            }
                        }
                        defaults.server = uricheck[2];
                        if (typeof uricheck[3] !== 'undefined') {
                            defaults.port = uricheck[3];
                        }
                        if (typeof uricheck[4] !== 'undefined') {
                            defaults.channel = '#' + uricheck[4];
                            if (typeof uricheck[5] !== 'undefined') {
                                defaults.channel_key = uricheck[5];
                            }
                        }
                    }
                    parts = [];
                } else {
                    // Extract the port+ssl if we find one
                    if (parts[0].search(/:/) > 0) {
                        defaults.port = parts[0].substring(parts[0].search(/:/) + 1);
                        defaults.server = parts[0].substring(0, parts[0].search(/:/));
                        if (defaults.port[0] === '+') {
                            defaults.port = parseInt(defaults.port.substring(1), 10);
                            defaults.ssl = true;
                        } else {
                            defaults.ssl = false;
                        }

                    } else {
                        defaults.server = parts[0];
                    }

                    parts.shift();
                }
            }

            if (parts.length > 0 && parts[0]) {
                defaults.channel = '#' + parts[0];
                parts.shift();
            }
        }

        // If any settings have been given by the server.. override any auto detected settings
        /**
         * Get any server restrictions as set in the server config
         * These settings can not be changed in the server selection dialog
         */
        if (_kiwi.app.server_settings && _kiwi.app.server_settings.connection) {
            if (_kiwi.app.server_settings.connection.server) {
                defaults.server = _kiwi.app.server_settings.connection.server;
            }

            if (_kiwi.app.server_settings.connection.port) {
                defaults.port = _kiwi.app.server_settings.connection.port;
            }

            if (_kiwi.app.server_settings.connection.ssl) {
                defaults.ssl = _kiwi.app.server_settings.connection.ssl;
            }

            if (_kiwi.app.server_settings.connection.channel) {
                defaults.channel = _kiwi.app.server_settings.connection.channel;
            }

            if (_kiwi.app.server_settings.connection.channel_key) {
                defaults.channel_key = _kiwi.app.server_settings.connection.channel_key;
            }

            if (_kiwi.app.server_settings.connection.nick) {
                defaults.nick = _kiwi.app.server_settings.connection.nick;
            }
        }

        // Set any random numbers if needed
        defaults.nick = defaults.nick.replace('?', Math.floor(Math.random() * 100000).toString());

        if (getQueryVariable('encoding'))
            defaults.encoding = getQueryVariable('encoding');

        return defaults;
    },
};



// If within a closure, expose the kiwi globals
if (typeof global !== 'undefined') {
    global.kiwi = _kiwi.global;
} else {
    // Not within a closure so set a var in the current scope
    var kiwi = _kiwi.global;
}



(function () {

    _kiwi.model.Application = Backbone.Model.extend({
        /** _kiwi.view.Application */
        view: null,

        /** _kiwi.view.StatusMessage */
        message: null,

        initialize: function (options) {
            this.app_options = options;

            if (options.container) {
                this.set('container', options.container);
            }

            // The base url to the kiwi server
            this.set('base_path', options.base_path ? options.base_path : '');

            // Path for the settings.json file
            this.set('settings_path', options.settings_path ?
                    options.settings_path :
                    this.get('base_path') + '/assets/settings.json'
            );

            // Any options sent down from the server
            this.server_settings = options.server_settings || {};
            this.translations = options.translations || {};
            this.themes = options.themes || [];
            this.text_theme = options.text_theme || {};

            // The applet to initially load
            this.startup_applet_name = options.startup || 'kiwi_startup';

            // Set any default settings before anything else is applied
            if (this.server_settings && this.server_settings.client && this.server_settings.client.settings) {
                this.applyDefaultClientSettings(this.server_settings.client.settings);
            }
        },


        initializeInterfaces: function () {
            // Best guess at where the kiwi server is if not already specified
            var kiwi_server = this.app_options.kiwi_server || this.detectKiwiServer();

            // Set the gateway up
            _kiwi.gateway = new _kiwi.model.Gateway({kiwi_server: kiwi_server});
            this.bindGatewayCommands(_kiwi.gateway);

            this.initializeClient();
            this.initializeGlobals();

            this.view.barsHide(true);
        },


        detectKiwiServer: function () {
            // If running from file, default to localhost:7777 by default
            if (window.location.protocol === 'file:') {
                return 'http://localhost:7778';
            } else {
                // Assume the kiwi server is on the same server
                return window.location.protocol + '//' + window.location.host;
            }
        },


        showStartup: function() {
            this.startup_applet = _kiwi.model.Applet.load(this.startup_applet_name, {no_tab: true});
            this.startup_applet.tab = this.view.$('.console');
            this.startup_applet.view.show();

            _kiwi.global.events.emit('loaded');
        },


        initializeClient: function () {
            this.view = new _kiwi.view.Application({model: this, el: this.get('container')});

            // Takes instances of model_network
            this.connections = new _kiwi.model.NetworkPanelList();

            // If all connections are removed at some point, hide the bars
            this.connections.on('remove', _.bind(function() {
                if (this.connections.length === 0) {
                    this.view.barsHide();
                }
            }, this));

            // Applets panel list
            this.applet_panels = new _kiwi.model.PanelList();
            this.applet_panels.view.$el.addClass('panellist applets');
            this.view.$el.find('.tabs').append(this.applet_panels.view.$el);

            /**
             * Set the UI components up
             */
            this.controlbox = (new _kiwi.view.ControlBox({el: $('#kiwi .controlbox')[0]})).render();
            this.client_ui_commands = new _kiwi.misc.ClientUiCommands(this, this.controlbox);

            this.rightbar = new _kiwi.view.RightBar({el: this.view.$('.right_bar')[0]});
            this.topicbar = new _kiwi.view.TopicBar({el: this.view.$el.find('.topic')[0]});

            new _kiwi.view.AppToolbar({el: _kiwi.app.view.$el.find('.toolbar .app_tools')[0]});
            new _kiwi.view.ChannelTools({el: _kiwi.app.view.$el.find('.channel_tools')[0]});

            this.message = new _kiwi.view.StatusMessage({el: this.view.$el.find('.status_message')[0]});

            this.resize_handle = new _kiwi.view.ResizeHandler({el: this.view.$el.find('.memberlists_resize_handle')[0]});

            // Rejigg the UI sizes
            this.view.doLayout();
        },


        initializeGlobals: function () {
            _kiwi.global.connections = this.connections;

            _kiwi.global.panels = this.panels;
            _kiwi.global.panels.applets = this.applet_panels;

            _kiwi.global.components.Applet = _kiwi.model.Applet;
            _kiwi.global.components.Panel =_kiwi.model.Panel;
            _kiwi.global.components.MenuBox = _kiwi.view.MenuBox;
            _kiwi.global.components.DataStore = _kiwi.model.DataStore;
            _kiwi.global.components.Notification = _kiwi.view.Notification;
            _kiwi.global.components.Events = function() {
                return kiwi.events.createProxy();
            };
        },


        applyDefaultClientSettings: function (settings) {
            _.each(settings, function (value, setting) {
                if (typeof _kiwi.global.settings.get(setting) === 'undefined') {
                    _kiwi.global.settings.set(setting, value);
                }
            });
        },


        panels: (function() {
            var active_panel;

            var fn = function(panel_type) {
                var app = _kiwi.app,
                    panels;

                // Default panel type
                panel_type = panel_type || 'connections';

                switch (panel_type) {
                case 'connections':
                    panels = app.connections.panels();
                    break;
                case 'applets':
                    panels = app.applet_panels.models;
                    break;
                }

                // Active panels / server
                panels.active = active_panel;
                panels.server = app.connections.active_connection ?
                    app.connections.active_connection.panels.server :
                    null;

                return panels;
            };

            _.extend(fn, Backbone.Events);

            // Keep track of the active panel. Channel/query/server or applet
            fn.bind('active', function (new_active_panel) {
                var previous_panel = active_panel;
                active_panel = new_active_panel;

                _kiwi.global.events.emit('panel:active', {previous: previous_panel, active: active_panel});
            });

            return fn;
        })(),


        bindGatewayCommands: function (gw) {
            var that = this;

            // As soon as an IRC connection is made, show the full client UI
            gw.on('connection:connect', function (event) {
                that.view.barsShow();
            });


            /**
             * Handle the reconnections to the kiwi server
             */
            (function () {
                // 0 = non-reconnecting state. 1 = reconnecting state.
                var gw_stat = 0;

                gw.on('disconnect', function (event) {
                    that.view.$el.removeClass('connected');

                    // Reconnection phase will start to kick in
                    gw_stat = 1;
                });


                gw.on('reconnecting', function (event) {
                    var msg = translateText('client_models_application_reconnect_in_x_seconds', [event.delay/1000]) + '...';

                    // Only need to mention the repeating re-connection messages on server panels
                    _kiwi.app.connections.forEach(function(connection) {
                        connection.panels.server.addMsg('', styleText('quit', {text: msg}), 'action quit');
                    });
                });


                // After the socket has connected, kiwi handshakes and then triggers a kiwi:connected event
                gw.on('kiwi:connected', function (event) {
                    var msg;

                    that.view.$el.addClass('connected');

                    // Make the rpc globally available for plugins
                    _kiwi.global.rpc = _kiwi.gateway.rpc;

                    _kiwi.global.events.emit('connected');

                    // If we were reconnecting, show some messages we have connected back OK
                    if (gw_stat === 1) {

                        // No longer in the reconnection state
                        gw_stat = 0;

                        msg = translateText('client_models_application_reconnect_successfully') + ' :)';
                        that.message.text(msg, {timeout: 5000});

                        // Mention the re-connection on every channel
                        _kiwi.app.connections.forEach(function(connection) {
                            connection.reconnect();

                            connection.panels.server.addMsg('', styleText('rejoin', {text: msg}), 'action join');

                            connection.panels.forEach(function(panel) {
                                if (!panel.isChannel())
                                    return;

                                panel.addMsg('', styleText('rejoin', {text: msg}), 'action join');
                            });
                        });
                    }

                });
            })();


            gw.on('kiwi:reconfig', function () {
                $.getJSON(that.get('settings_path'), function (data) {
                    that.server_settings = data.server_settings || {};
                    that.translations = data.translations || {};
                });
            });


            gw.on('kiwi:jumpserver', function (data) {
                var serv;
                // No server set? Then nowhere to jump to.
                if (typeof data.kiwi_server === 'undefined')
                    return;

                serv = data.kiwi_server;

                // Strip any trailing slash from the end
                if (serv[serv.length-1] === '/')
                    serv = serv.substring(0, serv.length-1);

                // Force the jumpserver now?
                if (data.force) {
                    // Get an interval between 5 and 6 minutes so everyone doesn't reconnect it all at once
                    var jump_server_interval = Math.random() * (360 - 300) + 300;
                    jump_server_interval = 1;

                    // Tell the user we are going to disconnect, wait 5 minutes then do the actual reconnect
                    var msg = _kiwi.global.i18n.translate('client_models_application_jumpserver_prepare').fetch();
                    that.message.text(msg, {timeout: 10000});

                    setTimeout(function forcedReconnect() {
                        var msg = _kiwi.global.i18n.translate('client_models_application_jumpserver_reconnect').fetch();
                        that.message.text(msg, {timeout: 8000});

                        setTimeout(function forcedReconnectPartTwo() {
                            _kiwi.gateway.set('kiwi_server', serv);

                            _kiwi.gateway.reconnect(function() {
                                // Reconnect all the IRC connections
                                that.connections.forEach(function(con){ con.reconnect(); });
                            });
                        }, 5000);

                    }, jump_server_interval * 1000);
                }
            });
        }

    });

})();



_kiwi.model.Gateway = Backbone.Model.extend({

    initialize: function () {

        // For ease of access. The socket.io object
        this.socket = this.get('socket');

        // Used to check if a disconnection was unplanned
        this.disconnect_requested = false;
    },



    reconnect: function (callback) {
        this.disconnect_requested = true;
        this.socket.close();

        this.socket = null;
        this.connect(callback);
    },



    /**
    *   Connects to the server
    *   @param  {Function}  callback    A callback function to be invoked once Kiwi's server has connected to the IRC server
    */
    connect: function (callback) {
        var that = this;

        this.connect_callback = callback;

        this.socket = new EngineioTools.ReconnectingSocket(this.get('kiwi_server'), {
            transports: _kiwi.app.server_settings.transports || ['polling', 'websocket'],
            path: _kiwi.app.get('base_path') + '/transport',
            reconnect_max_attempts: 5,
            reconnect_delay: 2000
        });

        // If we have an existing RPC object, clean it up before replacing it
        if (this.rpc) {
            rpc.dispose();
        }
        this.rpc = new EngineioTools.Rpc(this.socket);

        this.socket.on('connect_failed', function (reason) {
            this.socket.disconnect();
            this.trigger("connect_fail", {reason: reason});
        });

        this.socket.on('error', function (e) {
            console.log("_kiwi.gateway.socket.on('error')", {reason: e});
            if (that.connect_callback) {
                that.connect_callback(e);
                delete that.connect_callback;
            }

            that.trigger("connect_fail", {reason: e});
        });

        this.socket.on('connecting', function (transport_type) {
            console.log("_kiwi.gateway.socket.on('connecting')");
            that.trigger("connecting");
        });

        /**
         * Once connected to the kiwi server send the IRC connect command along
         * with the IRC server details.
         * A `connect` event is sent from the kiwi server once connected to the
         * IRCD and the nick has been accepted.
         */
        this.socket.on('open', function () {
            // Reset the disconnect_requested flag
            that.disconnect_requested = false;

            // Each minute we need to trigger a heartbeat. Server expects 2min, but to be safe we do it every 1min
            var heartbeat = function() {
                if (!that.rpc) return;

                that.rpc('kiwi.heartbeat');
                that._heartbeat_tmr = setTimeout(heartbeat, 60000);
            };

            heartbeat();

            console.log("_kiwi.gateway.socket.on('open')");
        });

        this.rpc.on('too_many_connections', function () {
            that.trigger("connect_fail", {reason: 'too_many_connections'});
        });

        this.rpc.on('irc', function (response, data) {
            that.parse(data.command, data.data);
        });

        this.rpc.on('kiwi', function (response, data) {
            that.parseKiwi(data.command, data.data);
        });

        this.socket.on('close', function () {
            that.trigger("disconnect", {});
            console.log("_kiwi.gateway.socket.on('close')");
        });

        this.socket.on('reconnecting', function (status) {
            console.log("_kiwi.gateway.socket.on('reconnecting')");
            that.trigger("reconnecting", {delay: status.delay, attempts: status.attempts});
        });

        this.socket.on('reconnecting_failed', function () {
            console.log("_kiwi.gateway.socket.on('reconnect_failed')");
        });
    },


    /**
     * Return a new network object with the new connection details
     */
    newConnection: function(connection_info, callback_fn) {
        var that = this;

        // If not connected, connect first then re-call this function
        if (!this.isConnected()) {
            this.connect(function(err) {
                if (err) {
                    callback_fn(err);
                    return;
                }

                that.newConnection(connection_info, callback_fn);
            });

            return;
        }

        this.makeIrcConnection(connection_info, function(err, server_num) {
            var connection;

            if (!err) {
                if (!_kiwi.app.connections.getByConnectionId(server_num)){
                    var inf = {
                        connection_id: server_num,
                        nick: connection_info.nick,
                        address: connection_info.host,
                        port: connection_info.port,
                        ssl: connection_info.ssl,
                        password: connection_info.password
                    };
                    connection = new _kiwi.model.Network(inf);
                    _kiwi.app.connections.add(connection);
                }

                console.log("_kiwi.gateway.socket.on('connect')", connection);
                callback_fn && callback_fn(err, connection);

            } else {
                console.log("_kiwi.gateway.socket.on('error')", {reason: err});
                callback_fn && callback_fn(err);
            }
        });
    },


    /**
     * Make a new IRC connection and return its connection ID
     */
    makeIrcConnection: function(connection_info, callback_fn) {
        var server_info = {
            nick:       connection_info.nick,
            hostname:   connection_info.host,
            port:       connection_info.port,
            ssl:        connection_info.ssl,
            password:   connection_info.password
        };

        connection_info.options = connection_info.options || {};

        // A few optional parameters
        if (connection_info.options.encoding)
            server_info.encoding = connection_info.options.encoding;

        this.rpc('kiwi.connect_irc', server_info, function (err, server_num) {
            if (!err) {
                callback_fn && callback_fn(err, server_num);

            } else {
                callback_fn && callback_fn(err);
            }
        });
    },


    isConnected: function () {
        // TODO: Check this. Might want to use .readyState
        return this.socket;
    },



    parseKiwi: function (command, data) {
        var args;

        switch (command) {
        case 'connected':
            // Send some info on this client to the server
            args = {
                build_version: _kiwi.global.build_version
            };
            this.rpc('kiwi.client_info', args);

            this.connect_callback && this.connect_callback();
            delete this.connect_callback;

            break;
        }

        this.trigger('kiwi:' + command, data);
        this.trigger('kiwi', data);
    },

    /**
    *   Parses the response from the server
    */
    parse: function (command, data) {
        var network_trigger = '';

        // Trigger the connection specific events (used by Network objects)
        if (typeof data.connection_id !== 'undefined') {
            network_trigger = 'connection:' + data.connection_id.toString();

            this.trigger(network_trigger, {
                event_name: command,
                event_data: data
            });

            // Some events trigger a more in-depth event name
            if (command == 'message' && data.type) {
                this.trigger('connection ' + network_trigger, {
                    event_name: 'message:' + data.type,
                    event_data: data
                });
            }

            if (command == 'channel' && data.type) {
                this.trigger('connection ' + network_trigger, {
                    event_name: 'channel:' + data.type,
                    event_data: data
                });
            }
        }

        // Trigger the global events
        this.trigger('connection', {event_name: command, event_data: data});
        this.trigger('connection:' + command, data);
    },

    /**
    *   Make an RPC call with the connection_id as the first argument
    *   @param  {String}    method          RPC method name
    *   @param  {Number}    connection_id   Connection ID this call relates to
    */
    rpcCall: function(method, connection_id) {
        var args = Array.prototype.slice.call(arguments, 0);

        if (typeof args[1] === 'undefined' || args[1] === null)
            args[1] = _kiwi.app.connections.active_connection.get('connection_id');

        return this.rpc.apply(this.rpc, args);
    },

    /**
    *   Sends a PRIVMSG message
    *   @param  {String}    target      The target of the message (e.g. a channel or nick)
    *   @param  {String}    msg         The message to send
    *   @param  {Function}  callback    A callback function
    */
    privmsg: function (connection_id, target, msg, callback) {
        var args = {
            target: target,
            msg: msg
        };

        this.rpcCall('irc.privmsg', connection_id, args, callback);
    },

    /**
    *   Sends a NOTICE message
    *   @param  {String}    target      The target of the message (e.g. a channel or nick)
    *   @param  {String}    msg         The message to send
    *   @param  {Function}  callback    A callback function
    */
    notice: function (connection_id, target, msg, callback) {
        var args = {
            target: target,
            msg: msg
        };

        this.rpcCall('irc.notice', connection_id, args, callback);
    },

    /**
    *   Sends a CTCP message
    *   @param  {Boolean}   request     Indicates whether this is a CTCP request (true) or reply (false)
    *   @param  {String}    type        The type of CTCP message, e.g. 'VERSION', 'TIME', 'PING' etc.
    *   @param  {String}    target      The target of the message, e.g a channel or nick
    *   @param  {String}    params      Additional paramaters
    *   @param  {Function}  callback    A callback function
    */
    ctcp: function (connection_id, is_request, type, target, params, callback) {
        var args = {
            is_request: is_request,
            type: type,
            target: target,
            params: params
        };

        this.rpcCall('irc.ctcp', connection_id, args, callback);
    },

    ctcpRequest: function (connection_id, type, target, params, callback) {
        this.ctcp(connection_id, true, type, target, params, callback);
    },
    ctcpResponse: function (connection_id, type, target, params, callback) {
        this.ctcp(connection_id, false, type, target, params, callback);
    },

    /**
    *   @param  {String}    target      The target of the message (e.g. a channel or nick)
    *   @param  {String}    msg         The message to send
    *   @param  {Function}  callback    A callback function
    */
    action: function (connection_id, target, msg, callback) {
        this.ctcp(connection_id, true, 'ACTION', target, msg, callback);
    },

    /**
    *   Joins a channel
    *   @param  {String}    channel     The channel to join
    *   @param  {String}    key         The key to the channel
    *   @param  {Function}  callback    A callback function
    */
    join: function (connection_id, channel, key, callback) {
        var args = {
            channel: channel,
            key: key
        };

        this.rpcCall('irc.join', connection_id, args, callback);
    },

    /**
    *   Retrieves channel information
    */
    channelInfo: function (connection_id, channel, callback) {
        var args = {
            channel: channel
        };

        this.rpcCall('irc.channel_info', connection_id, args, callback);
    },

    /**
    *   Leaves a channel
    *   @param  {String}    channel     The channel to part
    *   @param  {String}    message     Optional part message
    *   @param  {Function}  callback    A callback function
    */
    part: function (connection_id, channel, message, callback) {
        "use strict";

        // The message param is optional, so juggle args if it is missing
        if (typeof arguments[2] === 'function') {
            callback = arguments[2];
            message = undefined;
        }
        var args = {
            channel: channel,
            message: message
        };

        this.rpcCall('irc.part', connection_id, args, callback);
    },

    /**
    *   Queries or modifies a channell topic
    *   @param  {String}    channel     The channel to query or modify
    *   @param  {String}    new_topic   The new topic to set
    *   @param  {Function}  callback    A callback function
    */
    topic: function (connection_id, channel, new_topic, callback) {
        var args = {
            channel: channel,
            topic: new_topic
        };

        this.rpcCall('irc.topic', connection_id, args, callback);
    },

    /**
    *   Kicks a user from a channel
    *   @param  {String}    channel     The channel to kick the user from
    *   @param  {String}    nick        The nick of the user to kick
    *   @param  {String}    reason      The reason for kicking the user
    *   @param  {Function}  callback    A callback function
    */
    kick: function (connection_id, channel, nick, reason, callback) {
        var args = {
            channel: channel,
            nick: nick,
            reason: reason
        };

        this.rpcCall('irc.kick', connection_id, args, callback);
    },

    /**
    *   Disconnects us from the server
    *   @param  {String}    msg         The quit message to send to the IRC server
    *   @param  {Function}   callback    A callback function
    */
    quit: function (connection_id, msg, callback) {
        msg = msg || "";

        var args = {
            message: msg
        };

        this.rpcCall('irc.quit', connection_id, args, callback);
    },

    /**
    *   Sends a string unmodified to the IRC server
    *   @param  {String}    data        The data to send to the IRC server
    *   @param  {Function}  callback    A callback function
    */
    raw: function (connection_id, data, callback) {
        var args = {
            data: data
        };

        this.rpcCall('irc.raw', connection_id, args, callback);
    },

    /**
    *   Changes our nickname
    *   @param  {String}    new_nick    Our new nickname
    *   @param  {Function}  callback    A callback function
    */
    changeNick: function (connection_id, new_nick, callback) {
        var args = {
            nick: new_nick
        };

        this.rpcCall('irc.nick', connection_id, args, callback);
    },

    /**
    * Sets a mode for a target
    */
    mode: function (connection_id, target, mode_string, callback) {
        var args = {
            data: 'MODE ' + target + ' ' + mode_string
        };

        this.rpcCall('irc.raw', connection_id, args, callback);
    },

    /**
     *  Sends ENCODING change request to server.
     *  @param  {String}     new_encoding  The new proposed encode
     *  @param  {Fucntion}   callback      A callback function
     */
    setEncoding: function (connection_id, new_encoding, callback) {
        var args = {
            encoding: new_encoding
        };

        this.rpcCall('irc.encoding', connection_id, args, callback);
    }
});



(function () {

    _kiwi.model.Network = Backbone.Model.extend({
        defaults: {
            connection_id: 0,
            /**
            *   The name of the network
            *   @type    String
            */
            name: 'Network',

            /**
            *   The address (URL) of the network
            *   @type    String
            */
            address: '',

            /**
            *   The port for the network
            *   @type    Int
            */
            port: 6667,

            /**
            *   If this network uses SSL
            *   @type    Bool
            */
            ssl: false,

            /**
            *   The password to connect to this network
            *   @type    String
            */
            password: '',

            /**
            *   The current nickname
            *   @type   String
            */
            nick: '',

            /**
            *   The channel prefix for this network
            *   @type    String
            */
            channel_prefix: '#',

            /**
            *   The user prefixes for channel owner/admin/op/voice etc. on this network
            *   @type   Array
            */
            user_prefixes: [
                {symbol: '~', mode: 'q'},
                {symbol: '&', mode: 'a'},
                {symbol: '@', mode: 'o'},
                {symbol: '%', mode: 'h'},
                {symbol: '+', mode: 'v'}
            ],

            /**
            *   List of nicks we are ignoring
            *   @type Array
            */
            ignore_list: []
        },


        initialize: function () {
            // If we already have a connection, bind our events
            if (typeof this.get('connection_id') !== 'undefined') {
                this.gateway = _kiwi.global.components.Network(this.get('connection_id'));
                this.bindGatewayEvents();
            }

            // Create our panel list (tabs)
            this.panels = new _kiwi.model.PanelList([], this);
            //this.panels.network = this;

            // Automatically create a server tab
            var server_panel = new _kiwi.model.Server({name: 'Server', network: this});
            this.panels.add(server_panel);
            this.panels.server = this.panels.active = server_panel;
        },


        reconnect: function(callback_fn) {
            var that = this,
                server_info = {
                    nick:       this.get('nick'),
                    host:       this.get('address'),
                    port:       this.get('port'),
                    ssl:        this.get('ssl'),
                    password:   this.get('password')
                };

            _kiwi.gateway.makeIrcConnection(server_info, function(err, connection_id) {
                if (!err) {
                    that.gateway.dispose();

                    that.set('connection_id', connection_id);
                    that.gateway = _kiwi.global.components.Network(that.get('connection_id'));
                    that.bindGatewayEvents();

                    // Reset each of the panels connection ID
                    that.panels.forEach(function(panel) {
                        panel.set('connection_id', connection_id);
                    });

                    callback_fn && callback_fn(err);

                } else {
                    console.log("_kiwi.gateway.socket.on('error')", {reason: err});
                    callback_fn && callback_fn(err);
                }
            });
        },


        bindGatewayEvents: function () {
            //this.gateway.on('all', function() {console.log('ALL', this.get('connection_id'), arguments);});

            this.gateway.on('connect', onConnect, this);
            this.gateway.on('disconnect', onDisconnect, this);

            this.gateway.on('nick', function(event) {
                if (event.nick === this.get('nick')) {
                    this.set('nick', event.newnick);
                }
            }, this);

            this.gateway.on('options', onOptions, this);
            this.gateway.on('motd', onMotd, this);
            this.gateway.on('channel:join', onJoin, this);
            this.gateway.on('channel:part', onPart, this);
            this.gateway.on('channel:kick', onKick, this);
            this.gateway.on('quit', onQuit, this);
            this.gateway.on('message', onMessage, this);
            this.gateway.on('nick', onNick, this);
            this.gateway.on('ctcp_request', onCtcpRequest, this);
            this.gateway.on('ctcp_response', onCtcpResponse, this);
            this.gateway.on('topic', onTopic, this);
            this.gateway.on('topicsetby', onTopicSetBy, this);
            this.gateway.on('userlist', onUserlist, this);
            this.gateway.on('userlist_end', onUserlistEnd, this);
            this.gateway.on('banlist', onBanlist, this);
            this.gateway.on('mode', onMode, this);
            this.gateway.on('whois', onWhois, this);
            this.gateway.on('whowas', onWhowas, this);
            this.gateway.on('away', onAway, this);
            this.gateway.on('list_start', onListStart, this);
            this.gateway.on('irc_error', onIrcError, this);
            this.gateway.on('unknown_command', onUnknownCommand, this);
            this.gateway.on('channel_info', onChannelInfo, this);
            this.gateway.on('wallops', onWallops, this);
        },


        /**
         * Create panels and join the channel
         * This will not wait for the join event to create a panel. This
         * increases responsiveness in case of network lag
         */
        createAndJoinChannels: function (channels) {
            var that = this,
                panels = [];

            // Multiple channels may come as comma-delimited
            if (typeof channels === 'string') {
                channels = channels.split(',');
            }

            $.each(channels, function (index, channel_name_key) {
                // We may have a channel key so split it off
                var spli = channel_name_key.trim().split(' '),
                    channel_name = spli[0],
                    channel_key = spli[1] || '';

                // Trim any whitespace off the name
                channel_name = channel_name.trim();

                // Add channel_prefix in front of the first channel if missing
                if (that.get('channel_prefix').indexOf(channel_name[0]) === -1) {
                    // Could be many prefixes but '#' is highly likely the required one
                    channel_name = '#' + channel_name;
                }

                // Check if we have the panel already. If not, create it
                channel = that.panels.getByName(channel_name);
                if (!channel) {
                    channel = new _kiwi.model.Channel({name: channel_name, network: that});
                    that.panels.add(channel);
                }

                panels.push(channel);

                that.gateway.join(channel_name, channel_key);
            });


            return panels;
        },


        /**
         * Join all the open channels we have open
         * Reconnecting to a network would typically call this.
         */
        rejoinAllChannels: function() {
            var that = this;

            this.panels.forEach(function(panel) {
                if (!panel.isChannel())
                    return;

                that.gateway.join(panel.get('name'));
            });
        },

        isChannelName: function (channel_name) {
            var channel_prefix = this.get('channel_prefix');

            if (!channel_name || !channel_name.length) return false;
            return (channel_prefix.indexOf(channel_name[0]) > -1);
        },

        // Check a nick alongside our ignore list
        isNickIgnored: function (nick) {
            var idx, list = this.get('ignore_list');
            var pattern, regex;

            for (idx = 0; idx < list.length; idx++) {
                pattern = list[idx].replace(/([.+^$[\]\\(){}|-])/g, "\\$1")
                    .replace('*', '.*')
                    .replace('?', '.');

                regex = new RegExp(pattern, 'i');
                if (regex.test(nick)) return true;
            }

            return false;
        },

        // Create a new query panel
        createQuery: function (nick) {
            var that = this,
                query;

            // Check if we have the panel already. If not, create it
            query = that.panels.getByName(nick);
            if (!query) {
                query = new _kiwi.model.Query({name: nick});
                that.panels.add(query);
            }

            // In all cases, show the demanded query
            query.view.show();

            return query;
        }
    });



    function onDisconnect(event) {
        this.set('connected', false);

        $.each(this.panels.models, function (index, panel) {
            if (!panel.isApplet()) {
                panel.addMsg('', styleText('network_disconnected', {text: translateText('client_models_network_disconnected', [])}), 'action quit');
            }
        });
    }



    function onConnect(event) {
        var panels, channel_names;

        // Update our nick with what the network gave us
        this.set('nick', event.nick);

        this.set('connected', true);

        // If this is a re-connection then we may have some channels to re-join
        this.rejoinAllChannels();

        // Auto joining channels
        if (this.auto_join && this.auto_join.channel) {
            panels = this.createAndJoinChannels(this.auto_join.channel + ' ' + (this.auto_join.key || ''));

            // Show the last channel if we have one
            if (panels)
                panels[panels.length - 1].view.show();

            delete this.auto_join;
        }
    }



    function onOptions(event) {
        var that = this;

        $.each(event.options, function (name, value) {
            switch (name) {
            case 'CHANTYPES':
                that.set('channel_prefix', value.join(''));
                break;
            case 'NETWORK':
                that.set('name', value);
                break;
            case 'PREFIX':
                that.set('user_prefixes', value);
                break;
            }
        });

        this.set('cap', event.cap);
    }



    function onMotd(event) {
        this.panels.server.addMsg(this.get('name'), styleText('motd', {text: event.msg}), 'motd');
    }



    function onJoin(event) {
        var c, members, user;
        c = this.panels.getByName(event.channel);
        if (!c) {
            c = new _kiwi.model.Channel({name: event.channel, network: this});
            this.panels.add(c);
        }

        members = c.get('members');
        if (!members) return;

        // Do we already have this member?
        if (members.getByNick(event.nick)) {
            return;
        }

        user = new _kiwi.model.Member({
            nick: event.nick,
            ident: event.ident,
            hostname: event.hostname,
            user_prefixes: this.get('user_prefixes')
        });

        _kiwi.global.events.emit('channel:join', {channel: event.channel, user: user, network: this.gateway})
        .then(function() {
            members.add(user, {kiwi: event});
        });
    }



    function onPart(event) {
        var channel, members, user,
            part_options = {};

        part_options.type = 'part';
        part_options.message = event.message || '';
        part_options.time = event.time;

        channel = this.panels.getByName(event.channel);
        if (!channel) return;

        // If this is us, close the panel
        if (event.nick === this.get('nick')) {
            channel.close();
            return;
        }

        members = channel.get('members');
        if (!members) return;

        user = members.getByNick(event.nick);
        if (!user) return;

        _kiwi.global.events.emit('channel:leave', {channel: event.channel, user: user, type: 'part', message: part_options.message, network: this.gateway})
        .then(function() {
            members.remove(user, {kiwi: part_options});
        });
    }



    function onQuit(event) {
        var member, members,
            quit_options = {};

        quit_options.type = 'quit';
        quit_options.message = event.message || '';
        quit_options.time = event.time;

        $.each(this.panels.models, function (index, panel) {
            // Let any query panels know they quit
            if (panel.isQuery() && panel.get('name').toLowerCase() === event.nick.toLowerCase()) {
                panel.addMsg(' ', styleText('channel_quit', {
                    nick: event.nick,
                    text: translateText('client_models_channel_quit', [quit_options.message])
                }), 'action quit', {time: quit_options.time});
            }

            // Remove the nick from any channels
            if (panel.isChannel()) {
                member = panel.get('members').getByNick(event.nick);
                if (member) {
                    _kiwi.global.events.emit('channel:leave', {channel: panel.get('name'), user: member, type: 'quit', message: quit_options.message, network: this.gateway})
                    .then(function() {
                        panel.get('members').remove(member, {kiwi: quit_options});
                    });
                }
            }
        });
    }



    function onKick(event) {
        var channel, members, user,
            part_options = {};

        part_options.type = 'kick';
        part_options.by = event.nick;
        part_options.message = event.message || '';
        part_options.current_user_kicked = (event.kicked == this.get('nick'));
        part_options.current_user_initiated = (event.nick == this.get('nick'));
        part_options.time = event.time;

        channel = this.panels.getByName(event.channel);
        if (!channel) return;

        members = channel.get('members');
        if (!members) return;

        user = members.getByNick(event.kicked);
        if (!user) return;


        _kiwi.global.events.emit('channel:leave', {channel: event.channel, user: user, type: 'kick', message: part_options.message, network: this.gateway})
        .then(function() {
            members.remove(user, {kiwi: part_options});

            if (part_options.current_user_kicked) {
                members.reset([]);
            }
        });
    }



    function onMessage(event) {
        _kiwi.global.events.emit('message:new', {network: this.gateway, message: event})
        .then(_.bind(function() {
            var panel,
                is_pm = ((event.target || '').toLowerCase() == this.get('nick').toLowerCase());

            // An ignored user? don't do anything with it
            if (this.isNickIgnored(event.nick)) {
                return;
            }

            if (event.type == 'notice') {
                if (event.from_server) {
                    panel = this.panels.server;

                } else {
                    panel = this.panels.getByName(event.target) || this.panels.getByName(event.nick);

                    // Forward ChanServ messages to its associated channel
                    if (event.nick && event.nick.toLowerCase() == 'chanserv' && event.msg.charAt(0) == '[') {
                        channel_name = /\[([^ \]]+)\]/gi.exec(event.msg);
                        if (channel_name && channel_name[1]) {
                            channel_name = channel_name[1];

                            panel = this.panels.getByName(channel_name);
                        }
                    }

                }

                if (!panel) {
                    panel = this.panels.server;
                }

            } else if (is_pm) {
                // If a panel isn't found for this PM, create one
                panel = this.panels.getByName(event.nick);
                if (!panel) {
                    panel = new _kiwi.model.Query({name: event.nick, network: this});
                    this.panels.add(panel);
                }

            } else {
                // If a panel isn't found for this target, reroute to the
                // server panel
                panel = this.panels.getByName(event.target);
                if (!panel) {
                    panel = this.panels.server;
                }
            }

            switch (event.type){
            case 'message':
                panel.addMsg(event.nick, styleText('privmsg', {text: event.msg}), 'privmsg', {time: event.time});
                break;

            case 'action':
                panel.addMsg('', styleText('action', {nick: event.nick, text: event.msg}), 'action', {time: event.time});
                break;

            case 'notice':
                panel.addMsg('[' + (event.nick||'') + ']', styleText('notice', {text: event.msg}), 'notice', {time: event.time});

                // Show this notice to the active panel if it didn't have a set target, but only in an active channel or query window
                active_panel = _kiwi.app.panels().active;

                if (!event.from_server && panel === this.panels.server && active_panel !== this.panels.server) {
                    if (active_panel.get('network') === this && (active_panel.isChannel() || active_panel.isQuery()))
                        active_panel.addMsg('[' + (event.nick||'') + ']', styleText('notice', {text: event.msg}), 'notice', {time: event.time});
                }
                break;
            }
        }, this));
    }



    function onNick(event) {
        var member;

        $.each(this.panels.models, function (index, panel) {
            if (panel.get('name') == event.nick)
                panel.set('name', event.newnick);

            if (!panel.isChannel()) return;

            member = panel.get('members').getByNick(event.nick);
            if (member) {
                member.set('nick', event.newnick);
                panel.addMsg('', styleText('nick_changed', {nick: event.nick, text: translateText('client_models_network_nickname_changed', [event.newnick]), channel: name}), 'action nick', {time: event.time});
            }
        });
    }



    function onCtcpRequest(event) {
        // An ignored user? don't do anything with it
        if (this.isNickIgnored(event.nick)) {
            return;
        }

        // Reply to a TIME ctcp
        if (event.msg.toUpperCase() === 'TIME') {
            this.gateway.ctcpResponse(event.type, event.nick, (new Date()).toString());
        } else if(event.type.toUpperCase() === 'PING') { // CTCP PING reply
            this.gateway.ctcpResponse(event.type, event.nick, event.msg.substr(5));
        }
    }



    function onCtcpResponse(event) {
        // An ignored user? don't do anything with it
        if (this.isNickIgnored(event.nick)) {
            return;
        }

        this.panels.server.addMsg('[' + event.nick + ']',  styleText('ctcp', {text: event.msg}), 'ctcp', {time: event.time});
    }



    function onTopic(event) {
        var c;
        c = this.panels.getByName(event.channel);
        if (!c) return;

        // Set the channels topic
        c.set('topic', event.topic);

        // If this is the active channel, update the topic bar too
        if (c.get('name') === this.panels.active.get('name')) {
            _kiwi.app.topicbar.setCurrentTopic(event.topic);
        }
    }



    function onTopicSetBy(event) {
        var c, when;
        c = this.panels.getByName(event.channel);
        if (!c) return;

        when = new Date(event.when * 1000);
        c.set('topic_set_by', {nick: event.nick, when: when});
    }



    function onChannelInfo(event) {
        var channel = this.panels.getByName(event.channel);
        if (!channel) return;

        if (event.url) {
            channel.set('info_url', event.url);
        } else if (event.modes) {
            channel.set('info_modes', event.modes);
        }
    }



    function onUserlist(event) {
        var that = this,
            channel = this.panels.getByName(event.channel);

        // If we didn't find a channel for this, may aswell leave
        if (!channel) return;

        channel.temp_userlist = channel.temp_userlist || [];
        _.each(event.users, function (item) {
            var user = new _kiwi.model.Member({
                nick: item.nick,
                modes: item.modes,
                user_prefixes: that.get('user_prefixes')
            });
            channel.temp_userlist.push(user);
        });
    }



    function onUserlistEnd(event) {
        var channel;
        channel = this.panels.getByName(event.channel);

        // If we didn't find a channel for this, may aswell leave
        if (!channel) return;

        // Update the members list with the new list
        channel.get('members').reset(channel.temp_userlist || []);

        // Clear the temporary userlist
        delete channel.temp_userlist;
    }



    function onBanlist(event) {
        var channel = this.panels.getByName(event.channel);
        if (!channel)
            return;

        channel.set('banlist', event.bans || []);
    }



    function onMode(event) {
        var channel, i, prefixes, members, member, find_prefix,
            request_updated_banlist = false;

        // Build a nicely formatted string to be displayed to a regular human
        function friendlyModeString (event_modes, alt_target) {
            var modes = {}, return_string;

            // If no default given, use the main event info
            if (!event_modes) {
                event_modes = event.modes;
                alt_target = event.target;
            }

            // Reformat the mode object to make it easier to work with
            _.each(event_modes, function (mode){
                var param = mode.param || alt_target || '';

                // Make sure we have some modes for this param
                if (!modes[param]) {
                    modes[param] = {'+':'', '-':''};
                }

                modes[param][mode.mode[0]] += mode.mode.substr(1);
            });

            // Put the string together from each mode
            return_string = [];
            _.each(modes, function (modeset, param) {
                var str = '';
                if (modeset['+']) str += '+' + modeset['+'];
                if (modeset['-']) str += '-' + modeset['-'];
                return_string.push(str + ' ' + param);
            });
            return_string = return_string.join(', ');

            return return_string;
        }


        channel = this.panels.getByName(event.target);
        if (channel) {
            prefixes = this.get('user_prefixes');
            find_prefix = function (p) {
                return event.modes[i].mode[1] === p.mode;
            };
            for (i = 0; i < event.modes.length; i++) {
                if (_.any(prefixes, find_prefix)) {
                    if (!members) {
                        members = channel.get('members');
                    }
                    member = members.getByNick(event.modes[i].param);
                    if (!member) {
                        console.log('MODE command recieved for unknown member %s on channel %s', event.modes[i].param, event.target);
                        return;
                    } else {
                        if (event.modes[i].mode[0] === '+') {
                            member.addMode(event.modes[i].mode[1]);
                        } else if (event.modes[i].mode[0] === '-') {
                            member.removeMode(event.modes[i].mode[1]);
                        }
                        members.sort();
                    }
                } else {
                    // Channel mode being set
                    // TODO: Store this somewhere?
                    //channel.addMsg('', 'CHANNEL === ' + event.nick + ' set mode ' + event.modes[i].mode + ' on ' + event.target, 'action mode');
                }

                // TODO: Be smart, remove this specific ban from the banlist rather than request a whole banlist
                if (event.modes[i].mode[1] == 'b')
                    request_updated_banlist = true;
            }

            channel.addMsg('', styleText('mode', {nick: event.nick, text: translateText('client_models_network_mode', [friendlyModeString()]), channel: event.target}), 'action mode', {time: event.time});

            // TODO: Be smart, remove the specific ban from the banlist rather than request a whole banlist
            if (request_updated_banlist)
                this.gateway.raw('MODE ' + channel.get('name') + ' +b');

        } else {
            // This is probably a mode being set on us.
            if (event.target.toLowerCase() === this.get("nick").toLowerCase()) {
                this.panels.server.addMsg('', styleText('selfmode', {nick: event.nick, text: translateText('client_models_network_mode', [friendlyModeString()]), channel: event.target}), 'action mode');
            } else {
               console.log('MODE command recieved for unknown target %s: ', event.target, event);
            }
        }
    }



    function onWhois(event) {
        var logon_date, idle_time = '', panel;

        if (event.end)
            return;

        if (typeof event.idle !== 'undefined') {
            idle_time = secondsToTime(parseInt(event.idle, 10));
            idle_time = idle_time.h.toString().lpad(2, "0") + ':' + idle_time.m.toString().lpad(2, "0") + ':' + idle_time.s.toString().lpad(2, "0");
        }

        panel = _kiwi.app.panels().active;
        if (event.ident) {
            panel.addMsg(event.nick, styleText('whois_ident', {nick: event.nick, ident: event.ident, host: event.hostname, text: event.msg}), 'whois');

        } else if (event.chans) {
            panel.addMsg(event.nick, styleText('whois_channels', {nick: event.nick, text: translateText('client_models_network_channels', [event.chans])}), 'whois');
        } else if (event.irc_server) {
            panel.addMsg(event.nick, styleText('whois_server', {nick: event.nick, text: translateText('client_models_network_server', [event.irc_server, event.server_info])}), 'whois');
        } else if (event.msg) {
            panel.addMsg(event.nick, styleText('whois', {text: event.msg}), 'whois');
        } else if (event.logon) {
            logon_date = new Date();
            logon_date.setTime(event.logon * 1000);
            logon_date = _kiwi.utils.formatDate(logon_date);

            panel.addMsg(event.nick, styleText('whois_idle_and_signon', {nick: event.nick, text: translateText('client_models_network_idle_and_signon', [idle_time, logon_date])}), 'whois');
        } else if (event.away_reason) {
            panel.addMsg(event.nick, styleText('whois_away', {nick: event.nick, text: translateText('client_models_network_away', [event.away_reason])}), 'whois');
        } else {
            panel.addMsg(event.nick, styleText('whois_idle', {nick: event.nick, text: translateText('client_models_network_idle', [idle_time])}), 'whois');
        }
    }

    function onWhowas(event) {
        var panel;

        if (event.end)
            return;

        panel = _kiwi.app.panels().active;
        if (event.hostname) {
            panel.addMsg(event.nick, styleText('who', {nick: event.nick, ident: event.ident, host: event.hostname, realname: event.real_name, text: event.msg}), 'whois');
        } else {
            panel.addMsg(event.nick, styleText('whois_notfound', {nick: event.nick, text: translateText('client_models_network_nickname_notfound', [])}), 'whois');
        }
    }


    function onAway(event) {
        $.each(this.panels.models, function (index, panel) {
            if (!panel.isChannel()) return;

            member = panel.get('members').getByNick(event.nick);
            if (member) {
                member.set('away', !(!event.reason));
            }
        });
    }



    function onListStart(event) {
        var chanlist = _kiwi.model.Applet.loadOnce('kiwi_chanlist');
        chanlist.view.show();
    }



    function onIrcError(event) {
        var panel, tmp;

        if (event.channel !== undefined && !(panel = this.panels.getByName(event.channel))) {
            panel = this.panels.server;
        }

        switch (event.error) {
        case 'banned_from_channel':
            panel.addMsg(' ', styleText('channel_banned', {nick: event.nick, text: translateText('client_models_network_banned', [event.channel, event.reason]), channel: event.channel}), 'status');
            _kiwi.app.message.text(_kiwi.global.i18n.translate('client_models_network_banned').fetch(event.channel, event.reason));
            break;
        case 'bad_channel_key':
            panel.addMsg(' ', styleText('channel_badkey', {nick: event.nick, text: translateText('client_models_network_channel_badkey', [event.channel]), channel: event.channel}), 'status');
            _kiwi.app.message.text(_kiwi.global.i18n.translate('client_models_network_channel_badkey').fetch(event.channel));
            break;
        case 'invite_only_channel':
            panel.addMsg(' ', styleText('channel_inviteonly', {nick: event.nick, text: translateText('client_models_network_channel_inviteonly', [event.nick, event.channel]), channel: event.channel}), 'status');
            _kiwi.app.message.text(event.channel + ' ' + _kiwi.global.i18n.translate('client_models_network_channel_inviteonly').fetch());
            break;
        case 'user_on_channel':
            panel.addMsg(' ', styleText('channel_alreadyin', {nick: event.nick, text: translateText('client_models_network_channel_alreadyin'), channel: event.channel}));
            break;
        case 'channel_is_full':
            panel.addMsg(' ', styleText('channel_limitreached', {nick: event.nick, text: translateText('client_models_network_channel_limitreached', [event.channel]), channel: event.channel}), 'status');
            _kiwi.app.message.text(event.channel + ' ' + _kiwi.global.i18n.translate('client_models_network_channel_limitreached').fetch(event.channel));
            break;
        case 'chanop_privs_needed':
            panel.addMsg(' ', styleText('chanop_privs_needed', {text: event.reason, channel: event.channel}), 'status');
            _kiwi.app.message.text(event.reason + ' (' + event.channel + ')');
            break;
        case 'cannot_send_to_channel':
            panel.addMsg(' ', '== ' + _kiwi.global.i18n.translate('Cannot send message to channel, you are not voiced').fetch(event.channel, event.reason), 'status');
            break;
        case 'no_such_nick':
            tmp = this.panels.getByName(event.nick);
            if (tmp) {
                tmp.addMsg(' ', styleText('no_such_nick', {nick: event.nick, text: event.reason, channel: event.channel}), 'status');
            } else {
                this.panels.server.addMsg(' ', styleText('no_such_nick', {nick: event.nick, text: event.reason, channel: event.channel}), 'status');
            }
            break;
        case 'nickname_in_use':
            this.panels.server.addMsg(' ', styleText('nickname_alreadyinuse', {nick: event.nick, text: translateText('client_models_network_nickname_alreadyinuse', [event.nick]), channel: event.channel}), 'status');
            if (this.panels.server !== this.panels.active) {
                _kiwi.app.message.text(_kiwi.global.i18n.translate('client_models_network_nickname_alreadyinuse').fetch(event.nick));
            }

            // Only show the nickchange component if the controlbox is open
            if (_kiwi.app.controlbox.$el.css('display') !== 'none') {
                (new _kiwi.view.NickChangeBox()).render();
            }

            break;

        case 'password_mismatch':
            this.panels.server.addMsg(' ', styleText('channel_badpassword', {nick: event.nick, text: translateText('client_models_network_badpassword', []), channel: event.channel}), 'status');
            break;

        case 'error':
            if (event.reason) {
                this.panels.server.addMsg(' ', styleText('general_error', {text: event.reason}), 'status');
            }
            break;

        default:
            // We don't know what data contains, so don't do anything with it.
            //_kiwi.front.tabviews.server.addMsg(null, ' ', '== ' + data, 'status');
        }
    }


    function onUnknownCommand(event) {
        var display_params = _.clone(event.params);

        // A lot of commands have our nick as the first parameter. This is redundant for us
        if (display_params[0] && display_params[0] == this.get('nick')) {
            display_params.shift();
        }

        this.panels.server.addMsg('', styleText('unknown_command', {text: '[' + event.command + '] ' + display_params.join(', ', '')}));
    }


    function onWallops(event) {
        var active_panel = _kiwi.app.panels().active;

        // Send to server panel
        this.panels.server.addMsg('[' + (event.nick||'') + ']', styleText('wallops', {text: event.msg}), 'wallops', {time: event.time});

        // Send to active panel if its a channel/query *and* it's related to this network
        if (active_panel !== this.panels.server && (active_panel.isChannel() || active_panel.isQuery()) && active_panel.get('network') === this)
            active_panel.addMsg('[' + (event.nick||'') + ']', styleText('wallops', {text: event.msg}), 'wallops', {time: event.time});
    }

}

)();



_kiwi.model.Member = Backbone.Model.extend({
    initialize: function (attributes) {
        var nick, modes, prefix;

        // The nick may have a mode prefix, we don't want this
        nick = this.stripPrefix(this.get("nick"));

        // Make sure we have a mode array, and that it's sorted
        modes = this.get("modes");
        modes = modes || [];
        this.sortModes(modes);

        this.set({"nick": nick, "modes": modes, "prefix": this.getPrefix(modes)}, {silent: true});

        this.updateOpStatus();

        this.view = new _kiwi.view.Member({"model": this});
    },


    /**
     * Sort modes in order of importance
     */
    sortModes: function (modes) {
        var that = this;

        return modes.sort(function (a, b) {
            var a_idx, b_idx, i;
            var user_prefixes = that.get('user_prefixes');

            for (i = 0; i < user_prefixes.length; i++) {
                if (user_prefixes[i].mode === a) {
                    a_idx = i;
                }
            }

            for (i = 0; i < user_prefixes.length; i++) {
                if (user_prefixes[i].mode === b) {
                    b_idx = i;
                }
            }

            if (a_idx < b_idx) {
                return -1;
            } else if (a_idx > b_idx) {
                return 1;
            } else {
                return 0;
            }
        });
    },


    addMode: function (mode) {
        var modes_to_add = mode.split(''),
            modes, prefix;

        modes = this.get("modes");
        $.each(modes_to_add, function (index, item) {
            modes.push(item);
        });

        modes = this.sortModes(modes);
        this.set({"prefix": this.getPrefix(modes), "modes": modes});

        this.updateOpStatus();

        this.view.render();
    },


    removeMode: function (mode) {
        var modes_to_remove = mode.split(''),
            modes, prefix;

        modes = this.get("modes");
        modes = _.reject(modes, function (m) {
            return (_.indexOf(modes_to_remove, m) !== -1);
        });

        this.set({"prefix": this.getPrefix(modes), "modes": modes});

        this.updateOpStatus();

        this.view.render();
    },


    /**
     * Figure out a valid prefix given modes.
     * If a user is an op but also has voice, the prefix
     * should be the op as it is more important.
     */
    getPrefix: function (modes) {
        var prefix = '';
        var user_prefixes = this.get('user_prefixes');

        if (typeof modes[0] !== 'undefined') {
            prefix = _.detect(user_prefixes, function (prefix) {
                return prefix.mode === modes[0];
            });

            prefix = (prefix) ? prefix.symbol : '';
        }

        return prefix;
    },


    /**
     * Remove any recognised prefix from a nick
     */
    stripPrefix: function (nick) {
        var tmp = nick, i, j, k, nick_char;
        var user_prefixes = this.get('user_prefixes');

        i = 0;

        nick_character_loop:
        for (j = 0; j < nick.length; j++) {
            nick_char = nick.charAt(j);

            for (k = 0; k < user_prefixes.length; k++) {
                if (nick_char === user_prefixes[k].symbol) {
                    i++;
                    continue nick_character_loop;
                }
            }

            break;
        }

        return tmp.substr(i);
    },



    /**
     * Format this nick into readable format (eg. nick [ident@hostname])
     */
    displayNick: function (full) {
        var display = this.get('nick');

        if (full) {
            if (this.get("ident")) {
                display += ' [' + this.get("ident") + '@' + this.get("hostname") + ']';
            }
        }

        return display;
    },


    // Helper to quickly get user mask details
    getMaskParts: function () {
        return {
            nick: this.get('nick') || '',
            ident: this.get('ident') || '',
            hostname: this.get('hostname') || ''
        };
    },


    /**
     * With the modes set on the user, make note if we have some sort of op status
     */
    updateOpStatus: function () {
        var user_prefixes = this.get('user_prefixes'),
            modes = this.get('modes'),
            o, max_mode;

        if (modes.length > 0) {
            o = _.indexOf(user_prefixes, _.find(user_prefixes, function (prefix) {
                return prefix.mode === 'o';
            }));

            max_mode = _.indexOf(user_prefixes, _.find(user_prefixes, function (prefix) {
                return prefix.mode === modes[0];
            }));

            if ((max_mode === -1) || (max_mode > o)) {
                this.set({"is_op": false}, {silent: true});
            } else {
                this.set({"is_op": true}, {silent: true});
            }

        } else {
            this.set({"is_op": false}, {silent: true});
        }
    }
});


_kiwi.model.MemberList = Backbone.Collection.extend({
    model: _kiwi.model.Member,
    comparator: function (a, b) {
        var i, a_modes, b_modes, a_idx, b_idx, a_nick, b_nick;
        var user_prefixes = this.channel.get('network').get('user_prefixes');

        a_modes = a.get("modes");
        b_modes = b.get("modes");

        // Try to sort by modes first
        if (a_modes.length > 0) {
            // a has modes, but b doesn't so a should appear first
            if (b_modes.length === 0) {
                return -1;
            }
            a_idx = b_idx = -1;
            // Compare the first (highest) mode
            for (i = 0; i < user_prefixes.length; i++) {
                if (user_prefixes[i].mode === a_modes[0]) {
                    a_idx = i;
                }
            }
            for (i = 0; i < user_prefixes.length; i++) {
                if (user_prefixes[i].mode === b_modes[0]) {
                    b_idx = i;
                }
            }
            if (a_idx < b_idx) {
                return -1;
            } else if (a_idx > b_idx) {
                return 1;
            }
            // If we get to here both a and b have the same highest mode so have to resort to lexicographical sorting

        } else if (b_modes.length > 0) {
            // b has modes but a doesn't so b should appear first
            return 1;
        }
        a_nick = a.get("nick").toLocaleUpperCase();
        b_nick = b.get("nick").toLocaleUpperCase();
        // Lexicographical sorting
        if (a_nick < b_nick) {
            return -1;
        } else if (a_nick > b_nick) {
            return 1;
        } else {
            return 0;
        }
    },


    initialize: function (options) {
        this.view = new _kiwi.view.MemberList({"model": this});
        this.initNickCache();
    },


    /*
     * Keep a reference to each member by the nick. Speeds up .getByNick()
     * so it doesn't need to loop over every model for each nick lookup
     */
    initNickCache: function() {
        var that = this;

        this.nick_cache = Object.create(null);

        this.on('reset', function() {
            this.nick_cache = Object.create(null);

            this.models.forEach(function(member) {
                that.nick_cache[member.get('nick').toLowerCase()] = member;
            });
        });

        this.on('add', function(member) {
            that.nick_cache[member.get('nick').toLowerCase()] = member;
        });

        this.on('remove', function(member) {
            delete that.nick_cache[member.get('nick').toLowerCase()];
        });

        this.on('change:nick', function(member) {
            that.nick_cache[member.get('nick').toLowerCase()] = member;
            delete that.nick_cache[member.previous('nick').toLowerCase()];
        });
    },


    getByNick: function (nick) {
        if (typeof nick !== 'string') return;
        return this.nick_cache[nick.toLowerCase()];
    }
});


_kiwi.model.NewConnection = Backbone.Collection.extend({
    initialize: function() {
        this.view = new _kiwi.view.ServerSelect({model: this});

        this.view.bind('server_connect', this.onMakeConnection, this);

    },


    populateDefaultServerSettings: function() {
        var defaults = _kiwi.global.defaultServerSettings();
        this.view.populateFields(defaults);
    },


    onMakeConnection: function(new_connection_event) {
        var that = this;

        this.connect_details = new_connection_event;

        this.view.networkConnecting();

        _kiwi.gateway.newConnection({
            nick: new_connection_event.nick,
            host: new_connection_event.server,
            port: new_connection_event.port,
            ssl: new_connection_event.ssl,
            password: new_connection_event.password,
            options: new_connection_event.options
        }, function(err, network) {
            that.onNewNetwork(err, network);
        });
    },


    onNewNetwork: function(err, network) {
        // Show any errors if given
        if (err) {
            this.view.showError(err);
        }

        if (network && this.connect_details) {
            network.auto_join = {
                channel: this.connect_details.channel,
                key: this.connect_details.channel_key
            };

            this.trigger('new_network', network);
        }
    }
});


_kiwi.model.Panel = Backbone.Model.extend({
    initialize: function (attributes) {
        var name = this.get("name") || "";
        this.view = new _kiwi.view.Panel({"model": this, "name": name});
        this.set({
            "scrollback": [],
            "name": name
        }, {"silent": true});

        _kiwi.global.events.emit('panel:created', {panel: this});
    },

    close: function () {
        _kiwi.app.panels.trigger('close', this);
        _kiwi.global.events.emit('panel:close', {panel: this});

        if (this.view) {
            this.view.unbind();
            this.view.remove();
            this.view = undefined;
            delete this.view;
        }

        var members = this.get('members');
        if (members) {
            members.reset([]);
            this.unset('members');
        }

        this.get('panel_list').remove(this);

        this.unbind();
        this.destroy();
    },

    isChannel: function () {
        return false;
    },

    isQuery: function () {
        return false;
    },

    isApplet: function () {
        return false;
    },

    isServer: function () {
        return false;
    },

    isActive: function () {
        return (_kiwi.app.panels().active === this);
    }
});


_kiwi.model.PanelList = Backbone.Collection.extend({
    model: _kiwi.model.Panel,

    comparator: function (chan) {
        return chan.get('name');
    },
    initialize: function (elements, network) {
        var that = this;

        // If this PanelList is associated with a network/connection
        if (network) {
            this.network = network;
        }

        this.view = new _kiwi.view.Tabs({model: this});

        // Holds the active panel
        this.active = null;

        // Keep a tab on the active panel
        this.bind('active', function (active_panel) {
            this.active = active_panel;
        }, this);

        this.bind('add', function(panel) {
            panel.set('panel_list', this);
        });
    },



    getByCid: function (cid) {
        if (typeof name !== 'string') return;

        return this.find(function (c) {
            return cid === c.cid;
        });
    },



    getByName: function (name) {
        if (typeof name !== 'string') return;

        return this.find(function (c) {
            return name.toLowerCase() === c.get('name').toLowerCase();
        });
    }
});



_kiwi.model.NetworkPanelList = Backbone.Collection.extend({
    model: _kiwi.model.Network,

    initialize: function() {
        this.view = new _kiwi.view.NetworkTabs({model: this});
        
        this.on('add', this.onNetworkAdd, this);
        this.on('remove', this.onNetworkRemove, this);

        // Current active connection / panel
        this.active_connection = undefined;
        this.active_panel = undefined;

        // TODO: Remove this - legacy
        this.active = undefined;
    },

    getByConnectionId: function(id) {
        return this.find(function(connection){
            return connection.get('connection_id') == id;
        });
    },

    panels: function() {
        var panels = [];

        this.each(function(network) {
            panels = panels.concat(network.panels.models);
        });

        return panels;
    },


    onNetworkAdd: function(network) {
        network.panels.on('active', this.onPanelActive, this);

        // if it's our first connection, set it active
        if (this.models.length === 1) {
            this.active_connection = network;
            this.active_panel = network.panels.server;

            // TODO: Remove this - legacy
            this.active = this.active_panel;
        }
    },

    onNetworkRemove: function(network) {
        network.panels.off('active', this.onPanelActive, this);
    },

    onPanelActive: function(panel) {
        var connection = this.getByConnectionId(panel.tab.data('connection_id'));
        this.trigger('active', panel, connection);

        this.active_connection = connection;
        this.active_panel = panel;

        // TODO: Remove this - legacy
        this.active = panel;
    }
});


// TODO: Channel modes
// TODO: Listen to gateway events for anythign related to this channel
_kiwi.model.Channel = _kiwi.model.Panel.extend({
    initialize: function (attributes) {
        var name = this.get("name") || "",
            members;

        this.set({
            "members": new _kiwi.model.MemberList(),
            "name": name,
            "scrollback": [],
            "topic": ""
        }, {"silent": true});

        this.view = new _kiwi.view.Channel({"model": this, "name": name});

        members = this.get("members");
        members.channel = this;
        members.bind("add", function (member, members, options) {
            var show_message = _kiwi.global.settings.get('show_joins_parts');
            if (show_message === false) {
                return;
            }

            this.addMsg(' ', styleText('channel_join', {member: member.getMaskParts(), text: translateText('client_models_channel_join'), channel: name}), 'action join', {time: options.kiwi.time});
        }, this);

        members.bind("remove", function (member, members, options) {
            var show_message = _kiwi.global.settings.get('show_joins_parts');
            var msg = (options.kiwi.message) ? '(' + options.kiwi.message + ')' : '';

            if (options.kiwi.type === 'quit' && show_message) {
                this.addMsg(' ', styleText('channel_quit', {member: member.getMaskParts(), text: translateText('client_models_channel_quit', [msg]), channel: name}), 'action quit', {time: options.kiwi.time});

            } else if (options.kiwi.type === 'kick') {

                if (!options.kiwi.current_user_kicked) {
                    //If user kicked someone, show the message regardless of settings.
                    if (show_message || options.kiwi.current_user_initiated) {
                        this.addMsg(' ', styleText('channel_kicked', {member: member.getMaskParts(), text: translateText('client_models_channel_kicked', [options.kiwi.by, msg]), channel: name}), 'action kick', {time: options.kiwi.time});
                    }
                } else {
                    this.addMsg(' ', styleText('channel_selfkick', {text: translateText('client_models_channel_selfkick', [options.kiwi.by, msg]), channel: name}), 'action kick', {time: options.kiwi.time});
                }
            } else if (show_message) {
                this.addMsg(' ', styleText('channel_part', {member: member.getMaskParts(), text: translateText('client_models_channel_part', [msg]), channel: name}), 'action part', {time: options.kiwi.time});

            }
        }, this);

        _kiwi.global.events.emit('panel:created', {panel: this});
    },


    addMsg: function (nick, msg, type, opts) {
        var message_obj, bs, d, members, member,
            scrollback = (parseInt(_kiwi.global.settings.get('scrollback'), 10) || 250);

        opts = opts || {};

        // Time defaults to now
        if (typeof opts.time === 'number') {
            opts.time = new Date(opts.time);
        } else {
            opts.time = new Date();
        }

        // CSS style defaults to empty string
        if (!opts || typeof opts.style === 'undefined') {
            opts.style = '';
        }

        // Create a message object
        message_obj = {"msg": msg, "date": opts.date, "time": opts.time, "nick": nick, "chan": this.get("name"), "type": type, "style": opts.style};

        // If this user has one, get its prefix
        members = this.get('members');
        if (members) {
            member = members.getByNick(message_obj.nick);
            if (member) {
                message_obj.nick_prefix = member.get('prefix');
            }
        }

        // The CSS class (action, topic, notice, etc)
        if (typeof message_obj.type !== "string") {
            message_obj.type = '';
        }

        // Make sure we don't have NaN or something
        if (typeof message_obj.msg !== "string") {
            message_obj.msg = '';
        }

        // Update the scrollback
        bs = this.get("scrollback");
        if (bs) {
            bs.push(message_obj);

            // Keep the scrolback limited
            if (bs.length > scrollback) {
                bs = _.last(bs, scrollback);
            }
            this.set({"scrollback": bs}, {silent: true});
        }

        this.trigger("msg", message_obj);
    },


    clearMessages: function () {
        this.set({'scrollback': []}, {silent: true});
        this.addMsg('', 'Window cleared');

        this.view.render();
    },


    setMode: function(mode_string) {
        this.get('network').gateway.mode(this.get('name'), mode_string);
    },

    isChannel: function() {
        return true;
    }
});



_kiwi.model.Query = _kiwi.model.Channel.extend({
    initialize: function (attributes) {
        var name = this.get("name") || "",
            members;

        this.view = new _kiwi.view.Channel({"model": this, "name": name});
        this.set({
            "name": name,
            "scrollback": []
        }, {"silent": true});

        _kiwi.global.events.emit('panel:created', {panel: this});
    },

    isChannel: function () {
        return false;
    },

    isQuery: function () {
        return true;
    }
});


_kiwi.model.Server = _kiwi.model.Channel.extend({
    initialize: function (attributes) {
        var name = "Server";
        this.view = new _kiwi.view.Channel({"model": this, "name": name});
        this.set({
            "scrollback": [],
            "name": name
        }, {"silent": true});

        _kiwi.global.events.emit('panel:created', {panel: this});
    },

    isServer: function () {
        return true;
    },

    isChannel: function () {
        return false;
    }
});


_kiwi.model.Applet = _kiwi.model.Panel.extend({
    initialize: function (attributes) {
        // Temporary name
        var name = "applet_"+(new Date().getTime().toString()) + Math.ceil(Math.random()*100).toString();
        this.view = new _kiwi.view.Applet({model: this, name: name});

        this.set({
            "name": name
        }, {"silent": true});

        // Holds the loaded applet
        this.loaded_applet = null;
    },


    // Load an applet within this panel
    load: function (applet_object, applet_name) {
        if (typeof applet_object === 'object') {
            // Make sure this is a valid Applet
            if (applet_object.get || applet_object.extend) {

                // Try find a title for the applet
                this.set('title', applet_object.get('title') || _kiwi.global.i18n.translate('client_models_applet_unknown').fetch());

                // Update the tabs title if the applet changes it
                applet_object.bind('change:title', function (obj, new_value) {
                    this.set('title', new_value);
                }, this);

                // If this applet has a UI, add it now
                this.view.$el.html('');
                if (applet_object.view) {
                    this.view.$el.append(applet_object.view.$el);
                }

                // Keep a reference to this applet
                this.loaded_applet = applet_object;

                this.loaded_applet.trigger('applet_loaded');
            }

        } else if (typeof applet_object === 'string') {
            // Treat this as a URL to an applet script and load it
            this.loadFromUrl(applet_object, applet_name);
        }

        return this;
    },


    loadFromUrl: function(applet_url, applet_name) {
        var that = this;

        this.view.$el.html(_kiwi.global.i18n.translate('client_models_applet_loading').fetch());
        $script(applet_url, function () {
            // Check if the applet loaded OK
            if (!_kiwi.applets[applet_name]) {
                that.view.$el.html(_kiwi.global.i18n.translate('client_models_applet_notfound').fetch());
                return;
            }

            // Load a new instance of this applet
            that.load(new _kiwi.applets[applet_name]());
        });
    },


    close: function () {
        this.view.$el.remove();
        this.destroy();

        this.view = undefined;

        // Call the applets dispose method if it has one
        if (this.loaded_applet && this.loaded_applet.dispose) {
            this.loaded_applet.dispose();
        }

        // Call the inherited close()
        this.constructor.__super__.close.apply(this, arguments);
    },

    isApplet: function () {
        return true;
    }
},


{
    // Load an applet type once only. If it already exists, return that
    loadOnce: function (applet_name) {

        // See if we have an instance loaded already
        var applet = _.find(_kiwi.app.panels('applets'), function(panel) {
            // Ignore if it's not an applet
            if (!panel.isApplet()) return;

            // Ignore if it doesn't have an applet loaded
            if (!panel.loaded_applet) return;

            if (panel.loaded_applet.get('_applet_name') === applet_name) {
                return true;
            }
        });

        if (applet) return applet;


        // If we didn't find an instance, load a new one up
        return this.load(applet_name);
    },


    load: function (applet_name, options) {
        var applet, applet_obj;

        options = options || {};

        applet_obj = this.getApplet(applet_name);

        if (!applet_obj)
            return;

        // Create the applet and load the content
        applet = new _kiwi.model.Applet();
        applet.load(new applet_obj({_applet_name: applet_name}));

        // Add it into the tab list if needed (default)
        if (!options.no_tab)
            _kiwi.app.applet_panels.add(applet);


        return applet;
    },


    getApplet: function (applet_name) {
        return _kiwi.applets[applet_name] || null;
    },


    register: function (applet_name, applet) {
        _kiwi.applets[applet_name] = applet;
    }
});


_kiwi.model.PluginManager = Backbone.Model.extend({
    initialize: function () {
        this.$plugin_holder = $('<div id="kiwi_plugins" style="display:none;"></div>')
            .appendTo(_kiwi.app.view.$el);

        this.loading_plugins = 0;
        this.loaded_plugins = {};
    },

    // Load an applet within this panel
    load: function (url) {
        var that = this;

        if (this.loaded_plugins[url]) {
            this.unload(url);
        }

        this.loading_plugins++;

        this.loaded_plugins[url] = $('<div></div>');
        this.loaded_plugins[url].appendTo(this.$plugin_holder)
            .load(url, _.bind(that.pluginLoaded, that));
    },


    unload: function (url) {
        if (!this.loaded_plugins[url]) {
            return;
        }

        this.loaded_plugins[url].remove();
        delete this.loaded_plugins[url];
    },


    // Called after each plugin is loaded
    pluginLoaded: function() {
        this.loading_plugins--;

        if (this.loading_plugins === 0) {
            this.trigger('loaded');
        }
    },
});


_kiwi.model.DataStore = Backbone.Model.extend({
	initialize: function () {
		this._namespace = '';
		this.new_data = {};
	},

	namespace: function (new_namespace) {
		if (new_namespace) this._namespace = new_namespace;
		return this._namespace;
	},

	// Overload the original save() method
	save: function () {
		localStorage.setItem(this._namespace, JSON.stringify(this.attributes));
	},

	// Overload the original load() method
	load: function () {
		if (!localStorage) return;

		var data;

		try {
			data = JSON.parse(localStorage.getItem(this._namespace)) || {};
		} catch (error) {
			data = {};
		}

		this.attributes = data;
	}
},

{
	// Generates a new instance of DataStore with a set namespace
	instance: function (namespace, attributes) {
		var datastore = new _kiwi.model.DataStore(attributes);
		datastore.namespace(namespace);
		return datastore;
	}
});


_kiwi.model.ChannelInfo = Backbone.Model.extend({
    initialize: function () {
        this.view = new _kiwi.view.ChannelInfo({"model": this});
    }
});


_kiwi.view.Panel = Backbone.View.extend({
    tagName: "div",
    className: "panel",

    events: {
    },

    initialize: function (options) {
        this.initializePanel(options);
    },

    initializePanel: function (options) {
        this.$el.css('display', 'none');
        options = options || {};

        // Containing element for this panel
        if (options.container) {
            this.$container = $(options.container);
        } else {
            this.$container = $('#kiwi .panels .container1');
        }

        this.$el.appendTo(this.$container);

        this.alert_level = 0;

        this.model.set({"view": this}, {"silent": true});

        this.listenTo(this.model, 'change:activity_counter', function(model, new_count) {
            var $act = this.model.tab.find('.activity');

            if (new_count > 999) {
                $act.text('999+');
            } else {
                $act.text(new_count);
            }

            if (new_count === 0) {
                $act.addClass('zero');
            } else {
                $act.removeClass('zero');
            }
        });
    },

    render: function () {
    },


    show: function () {
        var $this = this.$el;

        // Hide all other panels and show this one
        this.$container.children('.panel').css('display', 'none');
        $this.css('display', 'block');

        // Show this panels memberlist
        var members = this.model.get("members");
        if (members) {
            _kiwi.app.rightbar.show();
            members.view.show();
        } else {
            _kiwi.app.rightbar.hide();
        }

        // Remove any alerts and activity counters for this panel
        this.alert('none');
        this.model.set('activity_counter', 0);

        _kiwi.app.panels.trigger('active', this.model, _kiwi.app.panels().active);
        this.model.trigger('active', this.model);

        _kiwi.app.view.doLayout();

        if (!this.model.isApplet())
            this.scrollToBottom(true);
    },


    alert: function (level) {
        // No need to highlight if this si the active panel
        if (this.model == _kiwi.app.panels().active) return;

        var types, type_idx;
        types = ['none', 'action', 'activity', 'highlight'];

        // Default alert level
        level = level || 'none';

        // If this alert level does not exist, assume clearing current level
        type_idx = _.indexOf(types, level);
        if (!type_idx) {
            level = 'none';
            type_idx = 0;
        }

        // Only 'upgrade' the alert. Never down (unless clearing)
        if (type_idx !== 0 && type_idx <= this.alert_level) {
            return;
        }

        // Clear any existing levels
        this.model.tab.removeClass(function (i, css) {
            return (css.match(/\balert_\S+/g) || []).join(' ');
        });

        // Add the new level if there is one
        if (level !== 'none') {
            this.model.tab.addClass('alert_' + level);
        }

        this.alert_level = type_idx;
    },


    // Scroll to the bottom of the panel
    scrollToBottom: function (force_down) {
        // If this isn't the active panel, don't scroll
        if (this.model !== _kiwi.app.panels().active) return;

        // Don't scroll down if we're scrolled up the panel a little
        if (force_down || this.$container.scrollTop() + this.$container.height() > this.$el.outerHeight() - 150) {
            this.$container[0].scrollTop = this.$container[0].scrollHeight;
        }
    }
});


_kiwi.view.Channel = _kiwi.view.Panel.extend({
    events: function(){
        var parent_events = this.constructor.__super__.events;

        if(_.isFunction(parent_events)){
            parent_events = parent_events();
        }
        return _.extend({}, parent_events, {
            'click .msg .nick' : 'nickClick',
            'click .msg .inline-nick' : 'nickClick',
            "click .chan": "chanClick",
            'click .media .open': 'mediaClick',
            'mouseenter .msg .nick': 'msgEnter',
            'mouseleave .msg .nick': 'msgLeave'
        });
    },

    initialize: function (options) {
        this.initializePanel(options);

        // Container for all the messages
        this.$messages = $('<div class="messages"></div>');
        this.$el.append(this.$messages);

        this.model.bind('change:topic', this.topic, this);
        this.model.bind('change:topic_set_by', this.topicSetBy, this);

        if (this.model.get('members')) {
            // When we join the memberlist, we have officially joined the channel
            this.model.get('members').bind('add', function (member) {
                if (member.get('nick') === this.model.collection.network.get('nick')) {
                    this.$el.find('.initial_loader').slideUp(function () {
                        $(this).remove();
                    });
                }
            }, this);

            // Memberlist reset with a new nicklist? Consider we have joined
            this.model.get('members').bind('reset', function(members) {
                if (members.getByNick(this.model.collection.network.get('nick'))) {
                    this.$el.find('.initial_loader').slideUp(function () {
                        $(this).remove();
                    });
                }
            }, this);
        }

        // Only show the loader if this is a channel (ie. not a query)
        if (this.model.isChannel()) {
            this.$el.append('<div class="initial_loader" style="margin:1em;text-align:center;"> ' + _kiwi.global.i18n.translate('client_views_channel_joining').fetch() + ' <span class="loader"></span></div>');
        }

        this.model.bind('msg', this.newMsg, this);
        this.msg_count = 0;
    },


    render: function () {
        var that = this;

        this.$messages.empty();
        _.each(this.model.get('scrollback'), function (msg) {
            that.newMsg(msg);
        });
    },


    newMsg: function(msg) {

        // Parse the msg object into properties fit for displaying
        msg = this.generateMessageDisplayObj(msg);

        _kiwi.global.events.emit('message:display', {panel: this.model, message: msg})
        .then(_.bind(function() {
            var line_msg;

            // Format the nick to the config defined format
            var display_obj = _.clone(msg);
            display_obj.nick = styleText('message_nick', {nick: msg.nick, prefix: msg.nick_prefix || ''});

            line_msg = '<div class="msg <%= type %> <%= css_classes %>"><div class="time"><%- time_string %></div><div class="nick" style="<%= nick_style %>"><%- nick %></div><div class="text" style="<%= style %>"><%= msg %> </div></div>';
            this.$messages.append($(_.template(line_msg, display_obj)).data('message', msg));

            // Activity/alerts based on the type of new message
            if (msg.type.match(/^action /)) {
                this.alert('action');

            } else if (msg.is_highlight) {
                _kiwi.app.view.alertWindow('* ' + _kiwi.global.i18n.translate('client_views_panel_activity').fetch());
                _kiwi.app.view.favicon.newHighlight();
                _kiwi.app.view.playSound('highlight');
                _kiwi.app.view.showNotification(this.model.get('name'), msg.unparsed_msg);
                this.alert('highlight');

            } else {
                // If this is the active panel, send an alert out
                if (this.model.isActive()) {
                    _kiwi.app.view.alertWindow('* ' + _kiwi.global.i18n.translate('client_views_panel_activity').fetch());
                }
                this.alert('activity');
            }

            if (this.model.isQuery() && !this.model.isActive()) {
                _kiwi.app.view.alertWindow('* ' + _kiwi.global.i18n.translate('client_views_panel_activity').fetch());

                // Highlights have already been dealt with above
                if (!msg.is_highlight) {
                    _kiwi.app.view.favicon.newHighlight();
                }

                _kiwi.app.view.showNotification(this.model.get('name'), msg.unparsed_msg);
                _kiwi.app.view.playSound('highlight');
            }

            // Update the activity counters
            (function () {
                // Only inrement the counters if we're not the active panel
                if (this.model.isActive()) return;

                var count_all_activity = _kiwi.global.settings.get('count_all_activity'),
                    exclude_message_types, new_count;

                // Set the default config value
                if (typeof count_all_activity === 'undefined') {
                    count_all_activity = false;
                }

                // Do not increment the counter for these message types
                exclude_message_types = [
                    'action join',
                    'action quit',
                    'action part',
                    'action kick',
                    'action nick',
                    'action mode'
                ];

                if (count_all_activity || _.indexOf(exclude_message_types, msg.type) === -1) {
                    new_count = this.model.get('activity_counter') || 0;
                    new_count++;
                    this.model.set('activity_counter', new_count);
                }

            }).apply(this);

            if(this.model.isActive()) this.scrollToBottom();

            // Make sure our DOM isn't getting too large (Acts as scrollback)
            this.msg_count++;
            if (this.msg_count > (parseInt(_kiwi.global.settings.get('scrollback'), 10) || 250)) {
                $('.msg:first', this.$messages).remove();
                this.msg_count--;
            }
        }, this));
    },


    // Let nicks be clickable + colourise within messages
    parseMessageNicks: function(word, colourise) {
        var members, member, style = '';

        members = this.model.get('members');
        if (!members) {
            return;
        }

        member = members.getByNick(word);
        if (!member) {
            return;
        }

        if (colourise !== false) {
            // Use the nick from the member object so the style matches the letter casing
            style = this.getNickStyles(member.get('nick')).asCssString();
        }

        return _.template('<span class="inline-nick" style="<%- style %>;cursor:pointer;" data-nick="<%- nick %>"><%- nick %></span>', {
            nick: word,
            style: style
        });

    },


    // Make channels clickable
    parseMessageChannels: function(word) {
        var re,
            parsed = false,
            network = this.model.get('network');

        if (!network) {
            return;
        }

        re = new RegExp('(^|\\s)([' + escapeRegex(network.get('channel_prefix')) + '][^ ,\\007]+)', 'g');

        if (!word.match(re)) {
            return parsed;
        }

        parsed = word.replace(re, function (m1, m2) {
            return m2 + '<a class="chan" data-channel="' + _.escape(m1.trim()) + '">' + _.escape(m1.trim()) + '</a>';
        });

        return parsed;
    },


    parseMessageUrls: function(word) {
        var found_a_url = false,
            parsed_url;

        parsed_url = word.replace(/^(([A-Za-z][A-Za-z0-9\-]*\:\/\/)|(www\.))([\w.\-]+)([a-zA-Z]{2,6})(:[0-9]+)?(\/[\w!:.?$'()[\]*,;~+=&%@!\-\/]*)?(#.*)?$/gi, function (url) {
            var nice = url,
                extra_html = '';

            // Don't allow javascript execution
            if (url.match(/^javascript:/)) {
                return url;
            }

            found_a_url = true;

            // Add the http if no protoocol was found
            if (url.match(/^www\./)) {
                url = 'http://' + url;
            }

            // Shorten the displayed URL if it's going to be too long
            if (nice.length > 100) {
                nice = nice.substr(0, 100) + '...';
            }

            // Get any media HTML if supported
            extra_html = _kiwi.view.MediaMessage.buildHtml(url);

            // Make the link clickable
            return '<a class="link_ext" target="_blank" rel="nofollow" href="' + url.replace(/"/g, '%22') + '">' + _.escape(nice) + '</a>' + extra_html;
        });

        return found_a_url ? parsed_url : false;
    },


    // Generate a css style for a nick
    getNickStyles: (function () {

        // Get a colour from a nick (Method based on IRSSIs nickcolor.pl)
        return function (nick) {
            var nick_lightness, nick_int, rgb;

            // Get the lightness option from the theme. Defaults to 35.
            nick_lightness = (_.find(_kiwi.app.themes, function (theme) {
                return theme.name.toLowerCase() === _kiwi.global.settings.get('theme').toLowerCase();
            }) || {}).nick_lightness;

            if (typeof nick_lightness !== 'number') {
                nick_lightness = 35;
            } else {
                nick_lightness = Math.max(0, Math.min(100, nick_lightness));
            }

            nick_int = _.reduce(nick.split(''), sumCharCodes, 0);
            rgb = hsl2rgb(nick_int % 256, 70, nick_lightness);

            return {
                color: '#' + ('000000' + (rgb[2] | (rgb[1] << 8) | (rgb[0] << 16)).toString(16)).substr(-6),
                asCssString: asCssString
            };
        };

        function toCssProperty(result, item, key) {
            return result + (typeof item === 'string' || typeof item === 'number' ? key + ':' + item + ';' : '');
        }
        function asCssString() {
            return _.reduce(this, toCssProperty, '');
        }
        function sumCharCodes(total, i) {
            return total + i.charCodeAt(0);
        }
    }()),


    // Takes an IRC message object and parses it for displaying
    generateMessageDisplayObj: function(msg) {
        var nick_hex, time_difference,
            message_words,
            sb = this.model.get('scrollback'),
            nick,
            regexpStr,
            prev_msg = sb[sb.length-2],
            hour, pm, am_pm_locale_key;

        // Clone the msg object so we dont modify the original
        msg = _.clone(msg);

        // Defaults
        msg.css_classes = '';
        msg.nick_style = '';
        msg.is_highlight = false;
        msg.time_string = '';

        // Nick + custom highlight detecting
        nick = _kiwi.app.connections.active_connection.get('nick');
        if (msg.nick.localeCompare(nick) !== 0) {
            // Build a list of all highlights and escape them for regex
            regexpStr = _.chain((_kiwi.global.settings.get('custom_highlights') || '').split(/[\s,]+/))
                .compact()
                .concat(nick)
                .map(escapeRegex)
                .join('|')
                .value();

            if (msg.msg.search(new RegExp('(\\b|\\W|^)(' + regexpStr + ')(\\b|\\W|$)', 'i')) > -1) {
                msg.is_highlight = true;
                msg.css_classes += ' highlight';
            }
        }

        message_words = msg.msg.split(' ');
        message_words = _.map(message_words, function(word) {
            var parsed_word;

            parsed_word = this.parseMessageUrls(word);
            if (typeof parsed_word === 'string') return parsed_word;

            parsed_word = this.parseMessageChannels(word);
            if (typeof parsed_word === 'string') return parsed_word;

            parsed_word = this.parseMessageNicks(word, (msg.type === 'privmsg'));
            if (typeof parsed_word === 'string') return parsed_word;

            parsed_word = _.escape(word);

            // Replace text emoticons with images
            if (_kiwi.global.settings.get('show_emoticons')) {
                parsed_word = emoticonFromText(parsed_word);
            }

            return parsed_word;
        }, this);

        msg.unparsed_msg = msg.msg;
        msg.msg = message_words.join(' ');

        // Convert IRC formatting into HTML formatting
        msg.msg = formatIRCMsg(msg.msg);

        // Add some style to the nick
        msg.nick_style = this.getNickStyles(msg.nick).asCssString();

        // Generate a hex string from the nick to be used as a CSS class name
        nick_hex = '';
        if (msg.nick) {
            _.map(msg.nick.split(''), function (char) {
                nick_hex += char.charCodeAt(0).toString(16);
            });
            msg.css_classes += ' nick_' + nick_hex;
        }

        if (prev_msg) {
            // Time difference between this message and the last (in minutes)
            time_difference = (msg.time.getTime() - prev_msg.time.getTime())/1000/60;
            if (prev_msg.nick === msg.nick && time_difference < 1) {
                msg.css_classes += ' repeated_nick';
            }
        }

        // Build up and add the line
        if (_kiwi.global.settings.get('use_24_hour_timestamps')) {
            msg.time_string = msg.time.getHours().toString().lpad(2, "0") + ":" + msg.time.getMinutes().toString().lpad(2, "0") + ":" + msg.time.getSeconds().toString().lpad(2, "0");
        } else {
            hour = msg.time.getHours();
            pm = hour > 11;

            hour = hour % 12;
            if (hour === 0)
                hour = 12;

            am_pm_locale_key = pm ?
                'client_views_panel_timestamp_pm' :
                'client_views_panel_timestamp_am';

            msg.time_string = translateText(am_pm_locale_key, hour + ":" + msg.time.getMinutes().toString().lpad(2, "0") + ":" + msg.time.getSeconds().toString().lpad(2, "0"));
        }

        return msg;
    },


    topic: function (topic) {
        if (typeof topic !== 'string' || !topic) {
            topic = this.model.get("topic");
        }

        this.model.addMsg('', styleText('channel_topic', {text: topic, channel: this.model.get('name')}), 'topic');

        // If this is the active channel then update the topic bar
        if (_kiwi.app.panels().active === this.model) {
            _kiwi.app.topicbar.setCurrentTopicFromChannel(this.model);
        }
    },

    topicSetBy: function (topic) {
        // If this is the active channel then update the topic bar
        if (_kiwi.app.panels().active === this.model) {
            _kiwi.app.topicbar.setCurrentTopicFromChannel(this.model);
        }
    },

    // Click on a nickname
    nickClick: function (event) {
        var $target = $(event.currentTarget),
            nick,
            members = this.model.get('members'),
            member;

        event.stopPropagation();

        // Check this current element for a nick before resorting to the main message
        // (eg. inline nicks has the nick on its own element within the message)
        nick = $target.data('nick');
        if (!nick) {
            nick = $target.parent('.msg').data('message').nick;
        }

        // Make sure this nick is still in the channel
        member = members ? members.getByNick(nick) : null;
        if (!member) {
            return;
        }

        _kiwi.global.events.emit('nick:select', {target: $target, member: member, source: 'message'})
        .then(_.bind(this.openUserMenuForNick, this, $target, member));
    },


    updateLastSeenMarker: function() {
        if (this.model.isActive()) {
            // Remove the previous last seen classes
            this.$(".last_seen").removeClass("last_seen");

            // Mark the last message the user saw
            this.$messages.children().last().addClass("last_seen");
        }
    },


    openUserMenuForNick: function ($target, member) {
        var members = this.model.get('members'),
            are_we_an_op = !!members.getByNick(_kiwi.app.connections.active_connection.get('nick')).get('is_op'),
            userbox, menubox;

        userbox = new _kiwi.view.UserBox();
        userbox.setTargets(member, this.model);
        userbox.displayOpItems(are_we_an_op);

        menubox = new _kiwi.view.MenuBox(member.get('nick') || 'User');
        menubox.addItem('userbox', userbox.$el);
        menubox.showFooter(false);

        _kiwi.global.events.emit('usermenu:created', {menu: menubox, userbox: userbox, user: member})
        .then(_.bind(function() {
            menubox.show();

            // Position the userbox + menubox
            var target_offset = $target.offset(),
                t = target_offset.top,
                m_bottom = t + menubox.$el.outerHeight(),  // Where the bottom of menu will be
                memberlist_bottom = this.$el.parent().offset().top + this.$el.parent().outerHeight();

            // If the bottom of the userbox is going to be too low.. raise it
            if (m_bottom > memberlist_bottom){
                t = memberlist_bottom - menubox.$el.outerHeight();
            }

            // Set the new positon
            menubox.$el.offset({
                left: target_offset.left,
                top: t
            });
        }, this))
        .catch(_.bind(function() {
            userbox = null;

            menu.dispose();
            menu = null;
        }, this));
    },


    chanClick: function (event) {
        var target = (event.target) ? $(event.target).data('channel') : $(event.srcElement).data('channel');

        _kiwi.app.connections.active_connection.gateway.join(target);
    },


    mediaClick: function (event) {
        var $media = $(event.target).parents('.media');
        var media_message;

        if ($media.data('media')) {
            media_message = $media.data('media');
        } else {
            media_message = new _kiwi.view.MediaMessage({el: $media[0]});

            // Cache this MediaMessage instance for when it's opened again
            $media.data('media', media_message);
        }

        media_message.toggle();
    },


    // Cursor hovers over a message
    msgEnter: function (event) {
        var nick_class;

        // Find a valid class that this element has
        _.each($(event.currentTarget).parent('.msg').attr('class').split(' '), function (css_class) {
            if (css_class.match(/^nick_[a-z0-9]+/i)) {
                nick_class = css_class;
            }
        });

        // If no class was found..
        if (!nick_class) return;

        $('.'+nick_class).addClass('global_nick_highlight');
    },


    // Cursor leaves message
    msgLeave: function (event) {
        var nick_class;

        // Find a valid class that this element has
        _.each($(event.currentTarget).parent('.msg').attr('class').split(' '), function (css_class) {
            if (css_class.match(/^nick_[a-z0-9]+/i)) {
                nick_class = css_class;
            }
        });

        // If no class was found..
        if (!nick_class) return;

        $('.'+nick_class).removeClass('global_nick_highlight');
    }
});



_kiwi.view.Applet = _kiwi.view.Panel.extend({
    className: 'panel applet',
    initialize: function (options) {
        this.initializePanel(options);
    }
});


_kiwi.view.Application = Backbone.View.extend({
    initialize: function () {
        var that = this;

        this.$el = $($('#tmpl_application').html().trim());
        this.el = this.$el[0];

        $(this.model.get('container') || 'body').append(this.$el);

        this.elements = {
            panels:        this.$el.find('.panels'),
            right_bar:     this.$el.find('.right_bar'),
            toolbar:       this.$el.find('.toolbar'),
            controlbox:    this.$el.find('.controlbox'),
            resize_handle: this.$el.find('.memberlists_resize_handle')
        };

        $(window).resize(function() { that.doLayout.apply(that); });
        this.elements.toolbar.resize(function() { that.doLayout.apply(that); });
        this.elements.controlbox.resize(function() { that.doLayout.apply(that); });

        // Change the theme when the config is changed
        _kiwi.global.settings.on('change:theme', this.updateTheme, this);
        this.updateTheme(getQueryVariable('theme'));

        _kiwi.global.settings.on('change:channel_list_style', this.setTabLayout, this);
        this.setTabLayout(_kiwi.global.settings.get('channel_list_style'));

        _kiwi.global.settings.on('change:show_timestamps', this.displayTimestamps, this);
        this.displayTimestamps(_kiwi.global.settings.get('show_timestamps'));

        this.$el.appendTo($('body'));
        this.doLayout();

        $(document).keydown(this.setKeyFocus);

        // Confirmation require to leave the page
        window.onbeforeunload = function () {
            if (_kiwi.gateway.isConnected()) {
                return _kiwi.global.i18n.translate('client_views_application_close_notice').fetch();
            }
        };

        // Keep tabs on the browser having focus
        this.has_focus = true;

        $(window).on('focus', function windowOnFocus() {
            that.has_focus = true;
        });

        $(window).on('blur', function windowOnBlur() {
            var active_panel = that.model.panels().active;
            if (active_panel && active_panel.view.updateLastSeenMarker) {
                active_panel.view.updateLastSeenMarker();
            }

            that.has_focus = false;
        });

        // If we get a touchstart event, make note of it so we know we're using a touchscreen
        $(window).on('touchstart', function windowOnTouchstart() {
            that.$el.addClass('touch');
            $(window).off('touchstart', windowOnTouchstart);
        });


        this.favicon = new _kiwi.view.Favicon();
        this.initSound();

        this.monitorPanelFallback();
    },



    updateTheme: function (theme_name) {
        // If called by the settings callback, get the correct new_value
        if (theme_name === _kiwi.global.settings) {
            theme_name = arguments[1];
        }

        // If we have no theme specified, get it from the settings
        if (!theme_name) theme_name = _kiwi.global.settings.get('theme') || 'relaxed';

        theme_name = theme_name.toLowerCase();

        // Clear any current theme
        $('[data-theme]:not([disabled])').each(function (idx, link) {
            var $link = $(link);
            $link.attr('rel', 'alternate ' + $link.attr('rel')).attr('disabled', true)[0].disabled = true;
        });

        // Apply the new theme
        var link = $('[data-theme][title=' + theme_name + ']');
        if (link.length > 0) {
            link.attr('rel', 'stylesheet').attr('disabled', false)[0].disabled = false;
        }

        this.doLayout();
    },


    setTabLayout: function (layout_style) {
        // If called by the settings callback, get the correct new_value
        if (layout_style === _kiwi.global.settings) {
            layout_style = arguments[1];
        }

        if (layout_style == 'list') {
            this.$el.addClass('chanlist_treeview');
        } else {
            this.$el.removeClass('chanlist_treeview');
        }

        this.doLayout();
    },


    displayTimestamps: function (show_timestamps) {
        // If called by the settings callback, get the correct new_value
        if (show_timestamps === _kiwi.global.settings) {
            show_timestamps = arguments[1];
        }

        if (show_timestamps) {
            this.$el.addClass('timestamps');
        } else {
            this.$el.removeClass('timestamps');
        }
    },


    // Globally shift focus to the command input box on a keypress
    setKeyFocus: function (ev) {
        // If we're copying text, don't shift focus
        if (ev.ctrlKey || ev.altKey || ev.metaKey) {
            return;
        }

        // If we're typing into an input box somewhere, ignore
        if ((ev.target.tagName.toLowerCase() === 'input') || (ev.target.tagName.toLowerCase() === 'textarea') || $(ev.target).attr('contenteditable')) {
            return;
        }

        $('#kiwi .controlbox .inp').focus();
    },


    doLayout: function () {
        var $kiwi = this.$el;
        var $panels = this.elements.panels;
        var $right_bar = this.elements.right_bar;
        var $toolbar = this.elements.toolbar;
        var $controlbox = this.elements.controlbox;
        var $resize_handle = this.elements.resize_handle;

        if (!$kiwi.is(':visible')) {
            return;
        }

        var css_heights = {
            top: $toolbar.outerHeight(true),
            bottom: $controlbox.outerHeight(true)
        };


        // If any elements are not visible, full size the panals instead
        if (!$toolbar.is(':visible')) {
            css_heights.top = 0;
        }

        if (!$controlbox.is(':visible')) {
            css_heights.bottom = 0;
        }

        // Apply the CSS sizes
        $panels.css(css_heights);
        $right_bar.css(css_heights);
        $resize_handle.css(css_heights);

        // If we have channel tabs on the side, adjust the height
        if ($kiwi.hasClass('chanlist_treeview')) {
            this.$el.find('.tabs', $kiwi).css(css_heights);
        }

        // Determine if we have a narrow window (mobile/tablet/or even small desktop window)
        if ($kiwi.outerWidth() < 420) {
            $kiwi.addClass('narrow');
            if (this.model.rightbar && this.model.rightbar.keep_hidden !== true)
                this.model.rightbar.toggle(true);
        } else {
            $kiwi.removeClass('narrow');
            if (this.model.rightbar && this.model.rightbar.keep_hidden !== false)
                this.model.rightbar.toggle(false);
        }

        // Set the panels width depending on the memberlist visibility
        if (!$right_bar.hasClass('disabled')) {
            // Panels to the side of the memberlist
            $panels.css('right', $right_bar.outerWidth(true));
            // The resize handle sits overlapping the panels and memberlist
            $resize_handle.css('left', $right_bar.position().left - ($resize_handle.outerWidth(true) / 2));
        } else {
            // Memberlist is hidden so panels to the right edge
            $panels.css('right', 0);
            // And move the handle just out of sight to the right
            $resize_handle.css('left', $panels.outerWidth(true));
        }

        var input_wrap_width = parseInt($controlbox.find('.input_tools').outerWidth(), 10);
        $controlbox.find('.input_wrap').css('right', input_wrap_width + 7);
    },


    alertWindow: function (title) {
        if (!this.alertWindowTimer) {
            this.alertWindowTimer = new (function () {
                var that = this;
                var tmr;
                var has_focus = true;
                var state = 0;
                var default_title = _kiwi.app.server_settings.client.window_title || 'Kiwi IRC';
                var title = 'Kiwi IRC';

                this.setTitle = function (new_title) {
                    new_title = new_title || default_title;
                    window.document.title = new_title;
                    return new_title;
                };

                this.start = function (new_title) {
                    // Don't alert if we already have focus
                    if (has_focus) return;

                    title = new_title;
                    if (tmr) return;
                    tmr = setInterval(this.update, 1000);
                };

                this.stop = function () {
                    // Stop the timer and clear the title
                    if (tmr) clearInterval(tmr);
                    tmr = null;
                    this.setTitle();

                    // Some browsers don't always update the last title correctly
                    // Wait a few seconds and then reset
                    setTimeout(this.reset, 2000);
                };

                this.reset = function () {
                    if (tmr) return;
                    that.setTitle();
                };


                this.update = function () {
                    if (state === 0) {
                        that.setTitle(title);
                        state = 1;
                    } else {
                        that.setTitle();
                        state = 0;
                    }
                };

                $(window).focus(function (event) {
                    has_focus = true;
                    that.stop();

                    // Some browsers don't always update the last title correctly
                    // Wait a few seconds and then reset
                    setTimeout(that.reset, 2000);
                });

                $(window).blur(function (event) {
                    has_focus = false;
                });
            })();
        }

        this.alertWindowTimer.start(title);
    },


    barsHide: function (instant) {
        var that = this;

        if (!instant) {
            this.$el.find('.toolbar').slideUp({queue: false, duration: 400, step: $.proxy(this.doLayout, this)});
            $('#kiwi .controlbox').slideUp({queue: false, duration: 400, step: $.proxy(this.doLayout, this)});
        } else {
            this.$el.find('.toolbar').slideUp(0);
            $('#kiwi .controlbox').slideUp(0);
            this.doLayout();
        }
    },

    barsShow: function (instant) {
        var that = this;

        if (!instant) {
            this.$el.find('.toolbar').slideDown({queue: false, duration: 400, step: $.proxy(this.doLayout, this)});
            $('#kiwi .controlbox').slideDown({queue: false, duration: 400, step: $.proxy(this.doLayout, this)});
        } else {
            this.$el.find('.toolbar').slideDown(0);
            $('#kiwi .controlbox').slideDown(0);
            this.doLayout();
        }
    },


    initSound: function () {
        var that = this,
            base_path = this.model.get('base_path');

        $script(base_path + '/assets/libs/soundmanager2/soundmanager2-nodebug-jsmin.js', function() {
            if (typeof soundManager === 'undefined')
                return;

            soundManager.setup({
                url: base_path + '/assets/libs/soundmanager2/',
                flashVersion: 9, // optional: shiny features (default = 8)// optional: ignore Flash where possible, use 100% HTML5 mode
                preferFlash: true,

                onready: function() {
                    that.sound_object = soundManager.createSound({
                        id: 'highlight',
                        url: base_path + '/assets/sound/highlight.mp3'
                    });
                }
            });
        });
    },


    playSound: function (sound_id) {
        if (!this.sound_object) return;

        if (_kiwi.global.settings.get('mute_sounds'))
            return;

        soundManager.play(sound_id);
    },


    showNotification: function(title, message) {
        var icon = this.model.get('base_path') + '/assets/img/ico.png',
            notifications = _kiwi.utils.notifications;

        if (!this.has_focus && notifications.allowed()) {
            notifications
                .create(title, { icon: icon, body: message })
                .closeAfter(5000)
                .on('click', _.bind(window.focus, window));
        }
    },

    monitorPanelFallback: function() {
        var panel_access = [];

        this.model.panels.on('active', function() {
            var panel = _kiwi.app.panels().active,
                panel_index;

            // If the panel is already open, remove it so we can put it back in first place
            panel_index = _.indexOf(panel_access, panel.cid);

            if (panel_index > -1) {
                panel_access.splice(panel_index, 1);
            }

            //Make this panel the most recently accessed
            panel_access.unshift(panel.cid);
        });

        this.model.panels.on('remove', function(panel) {
            // If closing the active panel, switch to the last-accessed panel
            if (panel_access[0] === panel.cid) {
                panel_access.shift();

                //Get the last-accessed panel model now that we removed the closed one
                var model = _.find(_kiwi.app.panels('applets').concat(_kiwi.app.panels('connections')), {cid: panel_access[0]});

                if (model) {
                    model.view.show();
                }
            }
        });
    }
});



_kiwi.view.AppToolbar = Backbone.View.extend({
    events: {
        'click .settings': 'clickSettings',
        'click .startup': 'clickStartup'
    },

    initialize: function () {
        // Remove the new connection/startup link if the server has disabled server changing
        if (_kiwi.app.server_settings.connection && !_kiwi.app.server_settings.connection.allow_change) {
            this.$('.startup').css('display', 'none');
        }
    },

    clickSettings: function (event) {
        event.preventDefault();
        _kiwi.app.controlbox.processInput('/settings');
    },

    clickStartup: function (event) {
        event.preventDefault();
        _kiwi.app.startup_applet.view.show();
    }
});



_kiwi.view.ControlBox = Backbone.View.extend({
    events: {
        'keydown .inp': 'process',
        'click .nick': 'showNickChange'
    },

    initialize: function () {
        var that = this;

        this.buffer = [];  // Stores previously run commands
        this.buffer_pos = 0;  // The current position in the buffer

        this.preprocessor = new InputPreProcessor();
        this.preprocessor.recursive_depth = 5;

        // Hold tab autocomplete data
        this.tabcomplete = {active: false, data: [], prefix: ''};

        // Keep the nick view updated with nick changes
        _kiwi.app.connections.on('change:nick', function(connection) {
            // Only update the nick view if it's the active connection
            if (connection !== _kiwi.app.connections.active_connection)
                return;

            $('.nick', that.$el).text(connection.get('nick'));
        });

        // Update our nick view as we flick between connections
        _kiwi.app.connections.on('active', function(panel, connection) {
            $('.nick', that.$el).text(connection.get('nick'));
        });

        // Keep focus on the input box as we flick between panels
        _kiwi.app.panels.bind('active', function (active_panel) {
            if (active_panel.isChannel() || active_panel.isServer() || active_panel.isQuery()) {
                that.$('.inp').focus();
            }
        });
    },

    render: function() {
        var send_message_text = translateText('client_views_controlbox_message');
        this.$('.inp').attr('placeholder', send_message_text);

        return this;
    },

    showNickChange: function (ev) {
        // Nick box already open? Don't do it again
        if (this.nick_change)
            return;

        this.nick_change = new _kiwi.view.NickChangeBox();
        this.nick_change.render();

        this.listenTo(this.nick_change, 'close', function() {
            delete this.nick_change;
        });
    },

    process: function (ev) {
        var that = this,
            inp = $(ev.currentTarget),
            inp_val = inp.val(),
            meta;

        if (navigator.appVersion.indexOf("Mac") !== -1) {
            meta = ev.metaKey;
        } else {
            meta = ev.altKey;
        }

        // If not a tab key, reset the tabcomplete data
        if (this.tabcomplete.active && ev.keyCode !== 9) {
            this.tabcomplete.active = false;
            this.tabcomplete.data = [];
            this.tabcomplete.prefix = '';
        }

        switch (true) {
        case (ev.keyCode === 13):              // return
            inp_val = inp_val.trim();

            if (inp_val) {
                $.each(inp_val.split('\n'), function (idx, line) {
                    that.processInput(line);
                });

                this.buffer.push(inp_val);
                this.buffer_pos = this.buffer.length;
            }

            inp.val('');
            return false;

            break;

        case (ev.keyCode === 38):              // up
            if (this.buffer_pos > 0) {
                this.buffer_pos--;
                inp.val(this.buffer[this.buffer_pos]);
            }
            //suppress browsers default behavior as it would set the cursor at the beginning
            return false;

        case (ev.keyCode === 40):              // down
            if (this.buffer_pos < this.buffer.length) {
                this.buffer_pos++;
                inp.val(this.buffer[this.buffer_pos]);
            }
            break;

        case (ev.keyCode === 219 && meta):            // [ + meta
            // Find all the tab elements and get the index of the active tab
            var $tabs = $('#kiwi .tabs').find('li[class!=connection]');
            var cur_tab_ind = (function() {
                for (var idx=0; idx<$tabs.length; idx++){
                    if ($($tabs[idx]).hasClass('active'))
                        return idx;
                }
            })();

            // Work out the previous tab along. Wrap around if needed
            if (cur_tab_ind === 0) {
                $prev_tab = $($tabs[$tabs.length - 1]);
            } else {
                $prev_tab = $($tabs[cur_tab_ind - 1]);
            }

            $prev_tab.click();
            return false;

        case (ev.keyCode === 221 && meta):            // ] + meta
            // Find all the tab elements and get the index of the active tab
            var $tabs = $('#kiwi .tabs').find('li[class!=connection]');
            var cur_tab_ind = (function() {
                for (var idx=0; idx<$tabs.length; idx++){
                    if ($($tabs[idx]).hasClass('active'))
                        return idx;
                }
            })();

            // Work out the next tab along. Wrap around if needed
            if (cur_tab_ind === $tabs.length - 1) {
                $next_tab = $($tabs[0]);
            } else {
                $next_tab = $($tabs[cur_tab_ind + 1]);
            }

            $next_tab.click();
            return false;

        case (ev.keyCode === 9     //Check if ONLY tab is pressed
            && !ev.shiftKey        //(user could be using some browser
            && !ev.altKey          //keyboard shortcut)
            && !ev.metaKey
            && !ev.ctrlKey):
            this.tabcomplete.active = true;
            if (_.isEqual(this.tabcomplete.data, [])) {
                // Get possible autocompletions
                var ac_data = [],
                    members = _kiwi.app.panels().active.get('members');

                // If we have a members list, get the models. Otherwise empty array
                members = members ? members.models : [];

                $.each(members, function (i, member) {
                    if (!member) return;
                    ac_data.push(member.get('nick'));
                });

                ac_data.push(_kiwi.app.panels().active.get('name'));

                ac_data = _.sortBy(ac_data, function (nick) {
                    return nick.toLowerCase();
                });
                this.tabcomplete.data = ac_data;
            }

            if (inp_val[inp[0].selectionStart - 1] === ' ') {
                return false;
            }

            (function () {
                var tokens,              // Words before the cursor position
                    val,                 // New value being built up
                    p1,                  // Position in the value just before the nick
                    newnick,             // New nick to be displayed (cycles through)
                    range,               // TextRange for setting new text cursor position
                    nick,                // Current nick in the value
                    trailing = ': ';     // Text to be inserted after a tabbed nick

                tokens = inp_val.substring(0, inp[0].selectionStart).split(' ');
                if (tokens[tokens.length-1] == ':')
                    tokens.pop();

                // Only add the trailing text if not at the beginning of the line
                if (tokens.length > 1)
                    trailing = '';

                nick  = tokens[tokens.length - 1];

                if (this.tabcomplete.prefix === '') {
                    this.tabcomplete.prefix = nick;
                }

                this.tabcomplete.data = _.select(this.tabcomplete.data, function (n) {
                    return (n.toLowerCase().indexOf(that.tabcomplete.prefix.toLowerCase()) === 0);
                });

                if (this.tabcomplete.data.length > 0) {
                    // Get the current value before cursor position
                    p1 = inp[0].selectionStart - (nick.length);
                    val = inp_val.substr(0, p1);

                    // Include the current selected nick
                    newnick = this.tabcomplete.data.shift();
                    this.tabcomplete.data.push(newnick);
                    val += newnick;

                    if (inp_val.substr(inp[0].selectionStart, 2) !== trailing)
                        val += trailing;

                    // Now include the rest of the current value
                    val += inp_val.substr(inp[0].selectionStart);

                    inp.val(val);

                    // Move the cursor position to the end of the nick
                    if (inp[0].setSelectionRange) {
                        inp[0].setSelectionRange(p1 + newnick.length + trailing.length, p1 + newnick.length + trailing.length);
                    } else if (inp[0].createTextRange) { // not sure if this bit is actually needed....
                        range = inp[0].createTextRange();
                        range.collapse(true);
                        range.moveEnd('character', p1 + newnick.length + trailing.length);
                        range.moveStart('character', p1 + newnick.length + trailing.length);
                        range.select();
                    }
                }
            }).apply(this);
            return false;
        }
    },


    processInput: function (command_raw) {
        var that = this,
            command, params, events_data,
            pre_processed;

        // If sending a message when not in a channel or query window, automatically
        // convert it into a command
        if (command_raw[0] !== '/' && !_kiwi.app.panels().active.isChannel() && !_kiwi.app.panels().active.isQuery()) {
            command_raw = '/' + command_raw;
        }

        // The default command
        if (command_raw[0] !== '/' || command_raw.substr(0, 2) === '//') {
            // Remove any slash escaping at the start (ie. //)
            command_raw = command_raw.replace(/^\/\//, '/');

            // Prepend the default command
            command_raw = '/msg ' + _kiwi.app.panels().active.get('name') + ' ' + command_raw;
        }

        // Process the raw command for any aliases
        this.preprocessor.vars.server = _kiwi.app.connections.active_connection.get('name');
        this.preprocessor.vars.channel = _kiwi.app.panels().active.get('name');
        this.preprocessor.vars.destination = this.preprocessor.vars.channel;
        command_raw = this.preprocessor.process(command_raw);

        // Extract the command and parameters
        params = command_raw.split(/\s/);
        if (params[0][0] === '/') {
            command = params[0].substr(1).toLowerCase();
            params = params.splice(1, params.length - 1);
        } else {
            // Default command
            command = 'msg';
            params.unshift(_kiwi.app.panels().active.get('name'));
        }

        // Emit a plugin event for any modifications
        events_data = {command: command, params: params};

        _kiwi.global.events.emit('command', events_data)
        .then(function() {
            // Trigger the command events
            that.trigger('command', {command: events_data.command, params: events_data.params});
            that.trigger('command:' + events_data.command, {command: events_data.command, params: events_data.params});

            // If we didn't have any listeners for this event, fire a special case
            // TODO: This feels dirty. Should this really be done..?
            if (!that._events['command:' + events_data.command]) {
                that.trigger('unknown_command', {command: events_data.command, params: events_data.params});
            }
        });
    },


    addPluginIcon: function ($icon) {
        var $tool = $('<div class="tool"></div>').append($icon);
        this.$el.find('.input_tools').append($tool);
        _kiwi.app.view.doLayout();
    }
});



_kiwi.view.Favicon = Backbone.View.extend({
    initialize: function () {
        var that = this,
            $win = $(window);

        this.has_focus = true;
        this.highlight_count = 0;
        // Check for html5 canvas support
        this.has_canvas_support = !!window.CanvasRenderingContext2D;

        // Store the original favicon
        this.original_favicon = $('link[rel~="icon"]')[0].href;

        // Create our favicon canvas
        this._createCanvas();

        // Reset favicon notifications when user focuses window
        $win.on('focus', function () {
            that.has_focus = true;
            that._resetHighlights();
        });
        $win.on('blur', function () {
            that.has_focus = false;
        });
    },

    newHighlight: function () {
        var that = this;
        if (!this.has_focus) {
            this.highlight_count++;
            if (this.has_canvas_support) {
                this._drawFavicon(function() {
                    that._drawBubble(that.highlight_count.toString());
                    that._refreshFavicon(that.canvas.toDataURL());
                });
            }
        }
    },

    _resetHighlights: function () {
        var that = this;
        this.highlight_count = 0;
        this._refreshFavicon(this.original_favicon);
    },

    _drawFavicon: function (callback) {
        var that = this,
            canvas = this.canvas,
            context = canvas.getContext('2d'),
            favicon_image = new Image();

        // Allow cross origin resource requests
        favicon_image.crossOrigin = 'anonymous';
        // Trigger the load event
        favicon_image.src = this.original_favicon;

        favicon_image.onload = function() {
            // Clear canvas from prevous iteration
            context.clearRect(0, 0, canvas.width, canvas.height);
            // Draw the favicon itself
            context.drawImage(favicon_image, 0, 0, canvas.width, canvas.height);
            callback();
        };
    },

    _drawBubble: function (label) {
        var letter_spacing,
            bubble_width = 0, bubble_height = 0,
            canvas = this.canvas,
            context = test_context = canvas.getContext('2d'),
            canvas_width = canvas.width,
            canvas_height = canvas.height;

        // Different letter spacing for MacOS 
        if (navigator.appVersion.indexOf("Mac") !== -1) {
            letter_spacing = -1.5;
        }
        else {
            letter_spacing = -1;
        }

        // Setup a test canvas to get text width
        test_context.font = context.font = 'bold 10px Arial';
        test_context.textAlign = 'right';
        this._renderText(test_context, label, 0, 0, letter_spacing);

        // Calculate bubble width based on letter spacing and padding
        bubble_width = test_context.measureText(label).width + letter_spacing * (label.length - 1) + 2;
        // Canvas does not have any way of measuring text height, so we just do it manually and add 1px top/bottom padding
        bubble_height = 9;

        // Set bubble coordinates
        bubbleX = canvas_width - bubble_width;
        bubbleY = canvas_height - bubble_height;

        // Draw bubble background
        context.fillStyle = 'red';
        context.fillRect(bubbleX, bubbleY, bubble_width, bubble_height);

        // Draw the text
        context.fillStyle = 'white';
        this._renderText(context, label, canvas_width - 1, canvas_height - 1, letter_spacing);
    },

    _refreshFavicon: function (url) {
        $('link[rel~="icon"]').remove();
        $('<link rel="shortcut icon" href="' + url + '">').appendTo($('head'));
    },

    _createCanvas: function () {
        var canvas = document.createElement('canvas');
            canvas.width = 16;
            canvas.height = 16;
        
        this.canvas = canvas;
    },

    _renderText: function (context, text, x, y, letter_spacing) {
        // A hacky solution for letter-spacing, but works well with small favicon text
        // Modified from http://jsfiddle.net/davidhong/hKbJ4/
        var current,
            characters = text.split('').reverse(),
            index = 0,
            currentPosition = x;

        while (index < text.length) {
            current = characters[index++];
            context.fillText(current, currentPosition, y);
            currentPosition += (-1 * (context.measureText(current).width + letter_spacing));
        }

        return context;
    }
});



_kiwi.view.MediaMessage = Backbone.View.extend({
    events: {
        'click .media_close': 'close'
    },

    initialize: function () {
        // Get the URL from the data
        this.url = this.$el.data('url');
    },

    toggle: function () {
        if (!this.$content || !this.$content.is(':visible')) {
            this.open();
        } else {
            this.close();
        }
    },

    // Close the media content and remove it from display
    close: function () {
        var that = this;
        this.$content.slideUp('fast', function () {
            that.$content.remove();
        });
    },

    // Open the media content within its wrapper
    open: function () {
        // Create the content div if we haven't already
        if (!this.$content) {
            this.$content = $('<div class="media_content"><a class="media_close"><i class="fa fa-chevron-up"></i> ' + _kiwi.global.i18n.translate('client_views_mediamessage_close').fetch() + '</a><br /><div class="content"></div></div>');
            this.$content.find('.content').append(this.mediaTypes[this.$el.data('type')].apply(this, []) || _kiwi.global.i18n.translate('client_views_mediamessage_notfound').fetch() + ' :(');
        }

        // Now show the content if not already
        if (!this.$content.is(':visible')) {
            // Hide it first so the slideDown always plays
            this.$content.hide();

            // Add the media content and slide it into view
            this.$el.append(this.$content);
            this.$content.slideDown();
        }
    },



    // Generate the media content for each recognised type
    mediaTypes: {
        twitter: function () {
            var tweet_id = this.$el.data('tweetid');
            var that = this;

            $.getJSON('https://api.twitter.com/1/statuses/oembed.json?id=' + tweet_id + '&callback=?', function (data) {
                that.$content.find('.content').html(data.html);
            });

            return $('<div>' + _kiwi.global.i18n.translate('client_views_mediamessage_load_tweet').fetch() + '...</div>');
        },


        image: function () {
            return $('<a href="' + this.url + '" target="_blank"><img height="100" src="' + this.url + '" /></a>');
        },


        imgur: function () {
            var that = this;

            $.getJSON('http://api.imgur.com/oembed?url=' + this.url, function (data) {
                var img_html = '<a href="' + data.url + '" target="_blank"><img height="100" src="' + data.url + '" /></a>';
                that.$content.find('.content').html(img_html);
            });

            return $('<div>' + _kiwi.global.i18n.translate('client_views_mediamessage_load_image').fetch() + '...</div>');
        },


        reddit: function () {
            var that = this;
            var matches = (/reddit\.com\/r\/([a-zA-Z0-9_\-]+)\/comments\/([a-z0-9]+)\/([^\/]+)?/gi).exec(this.url);

            $.getJSON('http://www.' + matches[0] + '.json?jsonp=?', function (data) {
                console.log('Loaded reddit data', data);
                var post = data[0].data.children[0].data;
                var thumb = '';

                // Show a thumbnail if there is one
                if (post.thumbnail) {
                    //post.thumbnail = 'http://www.eurotunnel.com/uploadedImages/commercial/back-steps-icon-arrow.png';

                    // Hide the thumbnail if an over_18 image
                    if (post.over_18) {
                        thumb = '<span class="thumbnail_nsfw" onclick="$(this).find(\'p\').remove(); $(this).find(\'img\').css(\'visibility\', \'visible\');">';
                        thumb += '<p style="font-size:0.9em;line-height:1.2em;cursor:pointer;">Show<br />NSFW</p>';
                        thumb += '<img src="' + post.thumbnail + '" class="thumbnail" style="visibility:hidden;" />';
                        thumb += '</span>';
                    } else {
                        thumb = '<img src="' + post.thumbnail + '" class="thumbnail" />';
                    }
                }

                // Build the template string up
                var tmpl = '<div>' + thumb + '<b><%- title %></b><br />Posted by <%- author %>. &nbsp;&nbsp; ';
                tmpl += '<i class="fa fa-arrow-up"></i> <%- ups %> &nbsp;&nbsp; <i class="fa fa-arrow-down"></i> <%- downs %><br />';
                tmpl += '<%- num_comments %> comments made. <a href="http://www.reddit.com<%- permalink %>">View post</a></div>';

                that.$content.find('.content').html(_.template(tmpl, post));
            });

            return $('<div>' + _kiwi.global.i18n.translate('client_views_mediamessage_load_reddit').fetch() + '...</div>');
        },


        youtube: function () {
            var ytid = this.$el.data('ytid');
            var that = this;
            var yt_html = '<iframe width="480" height="270" src="https://www.youtube.com/embed/'+ ytid +'?feature=oembed" frameborder="0" allowfullscreen=""></iframe>';
            that.$content.find('.content').html(yt_html);

            return $('');
        },


        gist: function () {
            var that = this,
                matches = (/https?:\/\/gist\.github\.com\/(?:[a-z0-9-]*\/)?([a-z0-9]+)(\#(.+))?$/i).exec(this.url);

            $.getJSON('https://gist.github.com/'+matches[1]+'.json?callback=?' + (matches[2] || ''), function (data) {
                $('body').append('<link rel="stylesheet" href="' + data.stylesheet + '" type="text/css" />');
                that.$content.find('.content').html(data.div);
            });

            return $('<div>' + _kiwi.global.i18n.translate('client_views_mediamessage_load_gist').fetch() + '...</div>');
        },

        spotify: function () {
            var uri = this.$el.data('uri'),
                method = this.$el.data('method'),
                spot, html;

            switch (method) {
                case "track":
                case "album":
                    spot = {
                        url: 'https://embed.spotify.com/?uri=' + uri,
                        width: 300,
                        height: 80
                    };
                    break;
                case "artist":
                    spot = {
                        url: 'https://embed.spotify.com/follow/1/?uri=' + uri +'&size=detail&theme=dark',
                        width: 300,
                        height: 56
                    };
                    break;
            }

            html = '<iframe src="' + spot.url + '" width="' + spot.width + '" height="' + spot.height + '" frameborder="0" allowtransparency="true"></iframe>';

            return $(html);
        },

        soundcloud: function () {
            var url = this.$el.data('url'),
                $content = $('<div></div>').text(_kiwi.global.i18n.translate('client_models_applet_loading').fetch());

            $.getJSON('https://soundcloud.com/oembed', { url: url })
                .then(function (data) {
                    $content.empty().append(
                        $(data.html).attr('height', data.height - 100)
                    );
                }, function () {
                    $content.text(_kiwi.global.i18n.translate('client_views_mediamessage_notfound').fetch());
                });

            return $content;
        },

        custom: function() {
            var type = this.constructor.types[this.$el.data('index')];

            if (!type)
                return;

            return $(type.buildHtml(this.$el.data('url')));
        }

    }
    }, {

    /**
     * Add a media message type to append HTML after a matching URL
     * match() should return a truthy value if it wants to handle this URL
     * buildHtml() should return the HTML string to be used within the drop down
     */
    addType: function(match, buildHtml) {
        if (typeof match !== 'function' || typeof buildHtml !== 'function')
            return;

        this.types = this.types || [];
        this.types.push({match: match, buildHtml: buildHtml});
    },


    // Build the closed media HTML from a URL
    buildHtml: function (url) {
        var html = '', matches;

        _.each(this.types || [], function(type, type_idx) {
            if (!type.match(url))
                return;

            // Add which media type should handle this media message. Will be read when it's clicked on
            html += '<span class="media" title="Open" data-type="custom" data-index="'+type_idx+'" data-url="' + _.escape(url) + '"><a class="open"><i class="fa fa-chevron-right"></i></a></span>';
        });

        // Is it an image?
        if (url.match(/(\.jpe?g|\.gif|\.bmp|\.png)\??$/i)) {
            html += '<span class="media image" data-type="image" data-url="' + url + '" title="Open Image"><a class="open"><i class="fa fa-chevron-right"></i></a></span>';
        }

        // Is this an imgur link not picked up by the images regex?
        matches = (/imgur\.com\/[^/]*(?!=\.[^!.]+($|\?))/ig).exec(url);
        if (matches && !url.match(/(\.jpe?g|\.gif|\.bmp|\.png)\??$/i)) {
            html += '<span class="media imgur" data-type="imgur" data-url="' + url + '" title="Open Image"><a class="open"><i class="fa fa-chevron-right"></i></a></span>';
        }

        // Is it a tweet?
        matches = (/https?:\/\/twitter.com\/([a-zA-Z0-9_]+)\/status\/([0-9]+)/ig).exec(url);
        if (matches) {
            html += '<span class="media twitter" data-type="twitter" data-url="' + url + '" data-tweetid="' + matches[2] + '" title="Show tweet information"><a class="open"><i class="fa fa-chevron-right"></i></a></span>';
        }

        // Is reddit?
        matches = (/reddit\.com\/r\/([a-zA-Z0-9_\-]+)\/comments\/([a-z0-9]+)\/([^\/]+)?/gi).exec(url);
        if (matches) {
            html += '<span class="media reddit" data-type="reddit" data-url="' + url + '" title="Reddit thread"><a class="open"><i class="fa fa-chevron-right"></i></a></span>';
        }

        // Is youtube?
        matches = (/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/ ]{11})/gi).exec(url);
        if (matches) {
            html += '<span class="media youtube" data-type="youtube" data-url="' + url + '" data-ytid="' + matches[1] + '" title="YouTube Video"><a class="open"><i class="fa fa-chevron-right"></i></a></span>';
        }

        // Is a github gist?
        matches = (/https?:\/\/gist\.github\.com\/(?:[a-z0-9-]*\/)?([a-z0-9]+)(\#(.+))?$/i).exec(url);
        if (matches) {
            html += '<span class="media gist" data-type="gist" data-url="' + url + '" data-gist_id="' + matches[1] + '" title="GitHub Gist"><a class="open"><i class="fa fa-chevron-right"></i></a></span>';
        }

        // Is this a spotify link?
        matches = (/http:\/\/(?:play|open\.)?spotify.com\/(album|track|artist)\/([a-zA-Z0-9]+)\/?/i).exec(url);
        if (matches) {
            // Make it a Spotify URI! (spotify:<type>:<id>)
            var method = matches[1],
                uri = "spotify:" + matches[1] + ":" + matches[2];
            html += '<span class="media spotify" data-type="spotify" data-uri="' + uri + '" data-method="' + method + '" title="Spotify ' + method + '"><a class="open"><i class="fa fa-chevron-right"></i></a></span>';
        }

        matches = (/(?:m\.)?(soundcloud\.com(?:\/.+))/i).exec(url);
        if (matches) {
            html += '<span class="media soundcloud" data-type="soundcloud" data-url="http://' + matches[1] + '" title="SoundCloud player"><a class="open"><i class="fa fa-chevron-right"></i></a></span>';
        }

        return html;
    }
});



_kiwi.view.Member = Backbone.View.extend({
    tagName: "li",
    initialize: function (options) {
        this.model.bind('change', this.render, this);
        this.render();
    },
    render: function () {
        var $this = this.$el,
            prefix_css_class = (this.model.get('modes') || []).join(' ');

        $this.attr('class', 'mode ' + prefix_css_class);
        $this.html('<a class="nick"><span class="prefix">' + this.model.get("prefix") + '</span>' + this.model.get("nick") + '</a>');

        return this;
    }
});


_kiwi.view.MemberList = Backbone.View.extend({
    tagName: "div",
    events: {
        "click .nick": "nickClick",
        "click .channel_info": "channelInfoClick"
    },

    initialize: function (options) {
        this.model.bind('all', this.render, this);
        this.$el.appendTo('#kiwi .memberlists');

        // Holds meta data. User counts, etc
        this.$meta = $('<div class="meta"></div>').appendTo(this.$el);

        // The list for holding the nicks
        this.$list = $('<ul></ul>').appendTo(this.$el);
    },
    render: function () {
        var that = this;

        this.$list.empty();
        this.model.forEach(function (member) {
            member.view.$el.data('member', member);
            that.$list.append(member.view.$el);
        });

        // User count
        if(this.model.channel.isActive()) {
            this.renderMeta();
        }

        return this;
    },

    renderMeta: function() {
        var members_count = this.model.length + ' ' + translateText('client_applets_chanlist_users');
        this.$meta.text(members_count);
    },

    nickClick: function (event) {
        var $target = $(event.currentTarget).parent('li'),
            member = $target.data('member');

        _kiwi.global.events.emit('nick:select', {target: $target, member: member, source: 'nicklist'})
        .then(_.bind(this.openUserMenuForItem, this, $target));
    },


    // Open a user menu for the given userlist item (<li>)
    openUserMenuForItem: function($target) {
        var member = $target.data('member'),
            userbox,
            are_we_an_op = !!this.model.getByNick(_kiwi.app.connections.active_connection.get('nick')).get('is_op');

        userbox = new _kiwi.view.UserBox();
        userbox.setTargets(member, this.model.channel);
        userbox.displayOpItems(are_we_an_op);

        var menu = new _kiwi.view.MenuBox(member.get('nick') || 'User');
        menu.addItem('userbox', userbox.$el);
        menu.showFooter(false);

        _kiwi.global.events.emit('usermenu:created', {menu: menu, userbox: userbox, user: member})
        .then(_.bind(function() {
            menu.show();

            var target_offset = $target.offset(),
                t = target_offset.top,
                m_bottom = t + menu.$el.outerHeight(),  // Where the bottom of menu will be
                memberlist_bottom = this.$el.parent().offset().top + this.$el.parent().outerHeight(),
                l = target_offset.left,
                m_right = l + menu.$el.outerWidth(),  // Where the left of menu will be
                memberlist_right = this.$el.parent().offset().left + this.$el.parent().outerWidth();

            // If the bottom of the userbox is going to be too low.. raise it
            if (m_bottom > memberlist_bottom){
                t = memberlist_bottom - menu.$el.outerHeight();
            }

            // If the top of the userbox is going to be too high.. lower it
            if (t < 0){
                t = 0;
            }

            // If the right of the userbox is going off screen.. bring it in
            if (m_right > memberlist_right){
                l = memberlist_right - menu.$el.outerWidth();
            }

            // Set the new positon
            menu.$el.offset({
                left: l,
                top: t
            });

        }, this))
        .catch(_.bind(function() {
            userbox = null;

            menu.dispose();
            menu = null;
        }, this));
    },


    channelInfoClick: function(event) {
        new _kiwi.model.ChannelInfo({channel: this.model.channel});
    },


    show: function () {
        $('#kiwi .memberlists').children().removeClass('active');
        $(this.el).addClass('active');

        this.renderMeta();
    }
});


_kiwi.view.MenuBox = Backbone.View.extend({
    events: {
        'click .ui_menu_foot .close, a.close_menu': 'dispose'
    },

    initialize: function(title) {
        var that = this;

        this.$el = $('<div class="ui_menu"><div class="items"></div></div>');

        this._title = title || '';
        this._items = {};
        this._display_footer = true;
        this._close_on_blur = true;
    },


    render: function() {
        var that = this,
            $title,
            $items = that.$el.find('.items');

        $items.find('*').remove();

        if (this._title) {
            $title = $('<div class="ui_menu_title"></div>')
                .text(this._title);

            this.$el.prepend($title);
        }

        _.each(this._items, function(item) {
            var $item = $('<div class="ui_menu_content hover"></div>')
                .append(item);

            $items.append($item);
        });

        if (this._display_footer)
            this.$el.append('<div class="ui_menu_foot"><a class="close" onclick="">Close <i class="fa fa-times"></i></a></div>');

    },


    setTitle: function(new_title) {
        this._title = new_title;

        if (!this._title)
            return;

        this.$el.find('.ui_menu_title').text(this._title);
    },


    onDocumentClick: function(event) {
        var $target = $(event.target);

        if (!this._close_on_blur)
            return;

        // If this is not itself AND we don't contain this element, dispose $el
        if ($target[0] != this.$el[0] && this.$el.has($target).length === 0)
            this.dispose();
    },


    dispose: function() {
        _.each(this._items, function(item) {
            item.dispose && item.dispose();
            item.remove && item.remove();
        });

        this._items = null;
        this.remove();

        if (this._close_proxy)
            $(document).off('click', this._close_proxy);
    },


    addItem: function(item_name, $item) {
        if ($item.is('a')) $item.addClass('fa fa-chevron-right');
        this._items[item_name] = $item;
    },


    removeItem: function(item_name) {
        delete this._items[item_name];
    },


    showFooter: function(show) {
        this._display_footer = show;
    },


    closeOnBlur: function(close_it) {
        this._close_on_blur = close_it;
    },


    show: function() {
        var that = this,
            $controlbox, menu_height;

        this.render();
        this.$el.appendTo(_kiwi.app.view.$el);

        // Ensure the menu doesn't get too tall to overlap the input bar at the bottom
        $controlbox = _kiwi.app.view.$el.find('.controlbox');
        $items = this.$el.find('.items');
        menu_height = this.$el.outerHeight() - $items.outerHeight();

        $items.css({
            'overflow-y': 'auto',
            'max-height': $controlbox.offset().top - this.$el.offset().top - menu_height
        });

        // We add this document click listener on the next javascript tick.
        // If the current tick is handling an existing click event (such as the nicklist click handler),
        // the click event bubbles up and hits the document therefore calling this callback to
        // remove this menubox before it's even shown.
        setTimeout(function() {
            that._close_proxy = function(event) {
                that.onDocumentClick(event);
            };
            $(document).on('click', that._close_proxy);
        }, 0);
    }
});



// Model for this = _kiwi.model.NetworkPanelList
_kiwi.view.NetworkTabs = Backbone.View.extend({
    tagName: 'ul',
    className: 'connections',

    initialize: function() {
        this.model.on('add', this.networkAdded, this);
        this.model.on('remove', this.networkRemoved, this);

        this.$el.appendTo(_kiwi.app.view.$el.find('.tabs'));
    },

    networkAdded: function(network) {
        $('<li class="connection"></li>')
            .append(network.panels.view.$el)
            .appendTo(this.$el);
    },

    networkRemoved: function(network) {
        // Remove the containing list element
        network.panels.view.$el.parent().remove();

        network.panels.view.remove();

        _kiwi.app.view.doLayout();
    }
});


_kiwi.view.NickChangeBox = Backbone.View.extend({
    events: {
        'submit': 'changeNick',
        'click .cancel': 'close'
    },

    initialize: function () {
        var text = {
            new_nick: _kiwi.global.i18n.translate('client_views_nickchangebox_new').fetch(),
            change: _kiwi.global.i18n.translate('client_views_nickchangebox_change').fetch(),
            cancel: _kiwi.global.i18n.translate('client_views_nickchangebox_cancel').fetch()
        };
        this.$el = $(_.template($('#tmpl_nickchange').html().trim(), text));
    },

    render: function () {
        // Add the UI component and give it focus
        _kiwi.app.controlbox.$el.prepend(this.$el);
        this.$el.find('input').focus();

        this.$el.css('bottom', _kiwi.app.controlbox.$el.outerHeight(true));
    },

    close: function () {
        this.$el.remove();
        this.trigger('close');
    },

    changeNick: function (event) {
        event.preventDefault();

        var connection = _kiwi.app.connections.active_connection;
        this.listenTo(connection, 'change:nick', function() {
            this.close();
        });

        connection.gateway.changeNick(this.$('input').val());
    }
});


_kiwi.view.ResizeHandler = Backbone.View.extend({
    events: {
        'mousedown': 'startDrag',
        'mouseup': 'stopDrag'
    },

    initialize: function () {
        this.dragging = false;
        this.starting_width = {};

        $(window).on('mousemove', $.proxy(this.onDrag, this));
    },

    startDrag: function (event) {
        this.dragging = true;
    },

    stopDrag: function (event) {
        this.dragging = false;
    },

    onDrag: function (event) {
        if (!this.dragging) return;

        var offset = $('#kiwi').offset().left;

        this.$el.css('left', event.clientX - (this.$el.outerWidth(true) / 2) - offset);
        $('#kiwi .right_bar').css('width', this.$el.parent().width() - (this.$el.position().left + this.$el.outerWidth()));
        _kiwi.app.view.doLayout();
    }
});


_kiwi.view.ServerSelect = Backbone.View.extend({
    events: {
        'submit form': 'submitForm',
        'click .show_more': 'showMore',
        'change .have_pass input': 'showPass',
        'change .have_key input': 'showKey',
        'click .fa-key': 'channelKeyIconClick',
        'click .show_server': 'showServer'
    },

    initialize: function () {
        var that = this,
            text = {
                think_nick: _kiwi.global.i18n.translate('client_views_serverselect_form_title').fetch(),
                nickname: _kiwi.global.i18n.translate('client_views_serverselect_nickname').fetch(),
                have_password: _kiwi.global.i18n.translate('client_views_serverselect_enable_password').fetch(),
                password: _kiwi.global.i18n.translate('client_views_serverselect_password').fetch(),
                channel: _kiwi.global.i18n.translate('client_views_serverselect_channel').fetch(),
                channel_key: _kiwi.global.i18n.translate('client_views_serverselect_channelkey').fetch(),
                require_key: _kiwi.global.i18n.translate('client_views_serverselect_channelkey_required').fetch(),
                key: _kiwi.global.i18n.translate('client_views_serverselect_key').fetch(),
                start: _kiwi.global.i18n.translate('client_views_serverselect_connection_start').fetch(),
                server_network: _kiwi.global.i18n.translate('client_views_serverselect_server_and_network').fetch(),
                server: _kiwi.global.i18n.translate('client_views_serverselect_server').fetch(),
                port: _kiwi.global.i18n.translate('client_views_serverselect_port').fetch(),
                powered_by: _kiwi.global.i18n.translate('client_views_serverselect_poweredby').fetch()
            };

        this.$el = $(_.template($('#tmpl_server_select').html().trim(), text));

        // Remove the 'more' link if the server has disabled server changing
        if (_kiwi.app.server_settings && _kiwi.app.server_settings.connection) {
            if (!_kiwi.app.server_settings.connection.allow_change) {
                this.$el.find('.show_more').remove();
                this.$el.addClass('single_server');
            }
        }

        // Are currently showing all the controlls or just a nick_change box?
        this.state = 'all';

        this.more_shown = false;

        this.model.bind('new_network', this.newNetwork, this);

        this.gateway = _kiwi.global.components.Network();
        this.gateway.on('connect', this.networkConnected, this);
        this.gateway.on('connecting', this.networkConnecting, this);
        this.gateway.on('disconnect', this.networkDisconnected, this);
        this.gateway.on('irc_error', this.onIrcError, this);
    },

    dispose: function() {
        this.model.off('new_network', this.newNetwork, this);
        this.gateway.off();

        this.remove();
    },

    submitForm: function (event) {
        event.preventDefault();

        // Make sure a nick is chosen
        if (!$('input.nick', this.$el).val().trim()) {
            this.setStatus(_kiwi.global.i18n.translate('client_views_serverselect_nickname_error_empty').fetch());
            $('input.nick', this.$el).select();
            return;
        }

        if (this.state === 'nick_change') {
            this.submitNickChange(event);
        } else {
            this.submitLogin(event);
        }

        $('button', this.$el).attr('disabled', 1);
        return;
    },

    submitLogin: function (event) {
        // If submitting is disabled, don't do anything
        if ($('button', this.$el).attr('disabled')) return;

        var values = {
            nick: $('input.nick', this.$el).val(),
            server: $('input.server', this.$el).val(),
            port: $('input.port', this.$el).val(),
            ssl: $('input.ssl', this.$el).prop('checked'),
            password: $('input.password', this.$el).val(),
            channel: $('input.channel', this.$el).val(),
            channel_key: $('input.channel_key', this.$el).val(),
            options: this.server_options
        };

        this.trigger('server_connect', values);
    },

    submitNickChange: function (event) {
        _kiwi.gateway.changeNick(null, $('input.nick', this.$el).val());
        this.networkConnecting();
    },

    showPass: function (event) {
        if (this.$el.find('tr.have_pass input').is(':checked')) {
            this.$el.find('tr.pass').show().find('input').focus();
        } else {
            this.$el.find('tr.pass').hide().find('input').val('');
        }
    },

    channelKeyIconClick: function (event) {
        this.$el.find('tr.have_key input').click();
    },

    showKey: function (event) {
        if (this.$el.find('tr.have_key input').is(':checked')) {
            this.$el.find('tr.key').show().find('input').focus();
        } else {
            this.$el.find('tr.key').hide().find('input').val('');
        }
    },

    showMore: function (event) {
        if (!this.more_shown) {
            $('.more', this.$el).slideDown('fast');
            $('.show_more', this.$el)
                .children('.fa-caret-down')
                .removeClass('fa-caret-down')
                .addClass('fa-caret-up');
            $('input.server', this.$el).select();
            this.more_shown = true;
        } else {
            $('.more', this.$el).slideUp('fast');
            $('.show_more', this.$el)
                .children('.fs-caret-up')
                .removeClass('fa-caret-up')
                .addClass('fa-caret-down');
            $('input.nick', this.$el).select();
            this.more_shown = false;
        }
    },

    populateFields: function (defaults) {
        var nick, server, port, channel, channel_key, ssl, password;

        defaults = defaults || {};

        nick = defaults.nick || '';
        server = defaults.server || '';
        port = defaults.port || 6667;
        ssl = defaults.ssl || 0;
        password = defaults.password || '';
        channel = defaults.channel || '';
        channel_key = defaults.channel_key || '';

        $('input.nick', this.$el).val(nick);
        $('input.server', this.$el).val(server);
        $('input.port', this.$el).val(port);
        $('input.ssl', this.$el).prop('checked', ssl);
        $('input#server_select_show_pass', this.$el).prop('checked', !(!password));
        $('input.password', this.$el).val(password);
        if (!(!password)) {
            $('tr.pass', this.$el).show();
        }
        $('input.channel', this.$el).val(channel);
        $('input#server_select_show_channel_key', this.$el).prop('checked', !(!channel_key));
        $('input.channel_key', this.$el).val(channel_key);
        if (!(!channel_key)) {
            $('tr.key', this.$el).show();
        }

        // Temporary values
        this.server_options = {};

        if (defaults.encoding)
            this.server_options.encoding = defaults.encoding;
    },

    hide: function () {
        this.$el.slideUp();
    },

    show: function (new_state) {
        new_state = new_state || 'all';

        this.$el.show();

        if (new_state === 'all') {
            $('.show_more', this.$el).show();

        } else if (new_state === 'more') {
            $('.more', this.$el).slideDown('fast');

        } else if (new_state === 'nick_change') {
            $('.more', this.$el).hide();
            $('.show_more', this.$el).hide();
            $('input.nick', this.$el).select();

        } else if (new_state === 'enter_password') {
            $('.more', this.$el).hide();
            $('.show_more', this.$el).hide();
            $('input.password', this.$el).select();
        }

        this.state = new_state;
    },

    infoBoxShow: function() {
        var $side_panel = this.$el.find('.side_panel');

        // Some theme may hide the info panel so check before we
        // resize ourselves
        if (!$side_panel.is(':visible'))
            return;

        this.$el.animate({
            width: parseInt($side_panel.css('left'), 10) + $side_panel.find('.content:first').outerWidth()
        });
    },

    infoBoxHide: function() {
        var $side_panel = this.$el.find('.side_panel');
        this.$el.animate({
            width: parseInt($side_panel.css('left'), 10)
        });
    },

    infoBoxSet: function($info_view) {
        this.$el.find('.side_panel .content')
            .empty()
            .append($info_view);
    },

    setStatus: function (text, class_name) {
        $('.status', this.$el)
            .text(text)
            .attr('class', 'status')
            .addClass(class_name||'')
            .show();
    },
    clearStatus: function () {
        $('.status', this.$el).hide();
    },

    reset: function() {
        this.populateFields();
        this.clearStatus();

        this.$('button').attr('disabled', null);
    },

    newNetwork: function(network) {
        // Keep a reference to this network so we can interact with it
        this.model.current_connecting_network = network;
    },

    networkConnected: function (event) {
        this.model.trigger('connected', _kiwi.app.connections.getByConnectionId(event.server));
        this.model.current_connecting_network = null;
    },

    networkDisconnected: function () {
        this.model.current_connecting_network = null;
        this.state = 'all';
    },

    networkConnecting: function (event) {
        this.model.trigger('connecting');
        this.setStatus(_kiwi.global.i18n.translate('client_views_serverselect_connection_trying').fetch(), 'ok');

        this.$('.status').append('<a class="show_server"><i class="fa fa-info-circle"></i></a>');
    },

    showServer: function() {
        // If we don't have a current connection in the making then we have nothing to show
        if (!this.model.current_connecting_network)
            return;

        _kiwi.app.view.barsShow();
        this.model.current_connecting_network.panels.server.view.show();
    },

    onIrcError: function (data) {
        $('button', this.$el).attr('disabled', null);

        switch(data.error) {
        case 'nickname_in_use':
            this.setStatus(_kiwi.global.i18n.translate('client_views_serverselect_nickname_error_alreadyinuse').fetch());
            this.show('nick_change');
            this.$el.find('.nick').select();
            break;
        case 'erroneus_nickname':
            if (data.reason) {
                this.setStatus(data.reason);
            } else {
                this.setStatus(_kiwi.global.i18n.translate('client_views_serverselect_nickname_invalid').fetch());
            }
            this.show('nick_change');
            this.$el.find('.nick').select();
            break;
        case 'password_mismatch':
            this.setStatus(_kiwi.global.i18n.translate('client_views_serverselect_password_incorrect').fetch());
            this.show('enter_password');
            this.$el.find('.password').select();
            break;
        default:
            this.showError(data.reason || '');
            break;
        }
    },

    showError: function (error_reason) {
        var err_text = _kiwi.global.i18n.translate('client_views_serverselect_connection_error').fetch();

        if (error_reason) {
            switch (error_reason) {
            case 'ENOTFOUND':
                err_text = _kiwi.global.i18n.translate('client_views_serverselect_server_notfound').fetch();
                break;

            case 'ECONNREFUSED':
                err_text += ' (' + _kiwi.global.i18n.translate('client_views_serverselect_connection_refused').fetch() + ')';
                break;

            default:
                err_text += ' (' + error_reason + ')';
            }
        }

        this.setStatus(err_text, 'error');
        $('button', this.$el).attr('disabled', null);
        this.show();
    }
});


_kiwi.view.StatusMessage = Backbone.View.extend({
    initialize: function () {
        this.$el.hide();

        // Timer for hiding the message after X seconds
        this.tmr = null;
    },

    text: function (text, opt) {
        // Defaults
        opt = opt || {};
        opt.type = opt.type || '';
        opt.timeout = opt.timeout || 5000;

        this.$el.text(text).addClass(opt.type);
        this.$el.slideDown($.proxy(_kiwi.app.view.doLayout, _kiwi.app.view));

        if (opt.timeout) this.doTimeout(opt.timeout);
    },

    html: function (html, opt) {
        // Defaults
        opt = opt || {};
        opt.type = opt.type || '';
        opt.timeout = opt.timeout || 5000;

        this.$el.html(html).addClass(opt.type);
        this.$el.slideDown($.proxy(_kiwi.app.view.doLayout, _kiwi.app.view));

        if (opt.timeout) this.doTimeout(opt.timeout);
    },

    hide: function () {
        this.$el.slideUp($.proxy(_kiwi.app.view.doLayout, _kiwi.app.view));
    },

    doTimeout: function (length) {
        if (this.tmr) clearTimeout(this.tmr);
        var that = this;
        this.tmr = setTimeout(function () { that.hide(); }, length);
    }
});


// Model for this = _kiwi.model.PanelList
_kiwi.view.Tabs = Backbone.View.extend({
    tagName: 'ul',
    className: 'panellist',

    events: {
        'click li': 'tabClick',
        'click li .part': 'partClick'
    },

    initialize: function () {
        this.model.on("add", this.panelAdded, this);
        this.model.on("remove", this.panelRemoved, this);
        this.model.on("reset", this.render, this);

        this.model.on('active', this.panelActive, this);

        // Network tabs start with a server, so determine what we are now
        this.is_network = false;

        if (this.model.network) {
            this.is_network = true;

            this.model.network.on('change:name', function (network, new_val) {
                $('span', this.model.server.tab).text(new_val);
            }, this);

            this.model.network.on('change:connection_id', function (network, new_val) {
                this.model.forEach(function(panel) {
                    panel.tab.data('connection_id', new_val);
                });
            }, this);
        }
    },

    render: function () {
        var that = this;

        this.$el.empty();

        if (this.is_network) {
            // Add the server tab first
            this.model.server.tab
                .data('panel', this.model.server)
                .data('connection_id', this.model.network.get('connection_id'))
                .appendTo(this.$el);
        }

        // Go through each panel adding its tab
        this.model.forEach(function (panel) {
            // If this is the server panel, ignore as it's already added
            if (this.is_network && panel == that.model.server)
                return;

            panel.tab.data('panel', panel);

            if (this.is_network)
                panel.tab.data('connection_id', this.model.network.get('connection_id'));

            panel.tab.appendTo(that.$el);
        });

        _kiwi.app.view.doLayout();
    },

    updateTabTitle: function (panel, new_title) {
        $('span', panel.tab).text(new_title);
    },

    panelAdded: function (panel) {
        // Add a tab to the panel
        panel.tab = $('<li><span></span><div class="activity"></div></li>');
        panel.tab.find('span').text(panel.get('title') || panel.get('name'));

        if (panel.isServer()) {
            panel.tab.addClass('server');
            panel.tab.addClass('fa');
            panel.tab.addClass('fa-nonexistant');
        }

        panel.tab.data('panel', panel);

        if (this.is_network)
            panel.tab.data('connection_id', this.model.network.get('connection_id'));

        this.sortTabs();

        panel.bind('change:title', this.updateTabTitle);
        panel.bind('change:name', this.updateTabTitle);

        _kiwi.app.view.doLayout();
    },
    panelRemoved: function (panel) {
        var connection = _kiwi.app.connections.active_connection;

        panel.tab.remove();
        delete panel.tab;

        _kiwi.app.panels.trigger('remove', panel);

        _kiwi.app.view.doLayout();
    },

    panelActive: function (panel, previously_active_panel) {
        // Remove any existing tabs or part images
        _kiwi.app.view.$el.find('.panellist .part').remove();
        _kiwi.app.view.$el.find('.panellist .active').removeClass('active');

        panel.tab.addClass('active');

        panel.tab.append('<span class="part fa fa-nonexistant"></span>');
    },

    tabClick: function (e) {
        var tab = $(e.currentTarget);

        var panel = tab.data('panel');
        if (!panel) {
            // A panel wasn't found for this tab... wadda fuck
            return;
        }

        panel.view.show();
    },

    partClick: function (e) {
        var tab = $(e.currentTarget).parent();
        var panel = tab.data('panel');

        if (!panel) return;

        // If the nicklist is empty, we haven't joined the channel as yet
        // If we part a server, then we need to disconnect from server, close channel tabs,
        // close server tab, then bring client back to homepage
        if (panel.isChannel() && panel.get('members').models.length > 0) {
            this.model.network.gateway.part(panel.get('name'));

        } else if(panel.isServer()) {
            if (!this.model.network.get('connected') || confirm(translateText('disconnect_from_server'))) {
                this.model.network.gateway.quit("Leaving");
                _kiwi.app.connections.remove(this.model.network);
                _kiwi.app.startup_applet.view.show();
            }

        } else {
            panel.close();
        }
    },

    sortTabs: function() {
        var that = this,
            panels = [];

        this.model.forEach(function (panel) {
            // Ignore the server tab, so all others get added after it
            if (that.is_network && panel == that.model.server)
                return;

            panels.push([panel.get('title') || panel.get('name'), panel]);
        });

        // Sort by the panel name..
        panels.sort(function(a, b) {
            if (a[0].toLowerCase() > b[0].toLowerCase()) {
                return 1;
            } else if (a[0].toLowerCase() < b[0].toLowerCase()) {
                return -1;
            } else {
                return 0;
            }
        });

        // And add them all back in order.
        _.each(panels, function(panel) {
            panel[1].tab.appendTo(that.$el);
        });
    }
});


_kiwi.view.TopicBar = Backbone.View.extend({
    events: {
        'keydown div': 'process'
    },

    initialize: function () {
        _kiwi.app.panels.bind('active', function (active_panel) {
            // If it's a channel topic, update and make editable
            if (active_panel.isChannel()) {
                this.setCurrentTopicFromChannel(active_panel);
                this.$el.find('div').attr('contentEditable', true);

            } else {
                // Not a channel topic.. clear and make uneditable
                this.$el.find('div').attr('contentEditable', false)
                    .text('');
            }
        }, this);
    },

    process: function (ev) {
        var inp = $(ev.currentTarget),
            inp_val = inp.text();

        // Only allow topic editing if this is a channel panel
        if (!_kiwi.app.panels().active.isChannel()) {
            return false;
        }

        // If hit return key, update the current topic
        if (ev.keyCode === 13) {
            _kiwi.app.connections.active_connection.gateway.topic(_kiwi.app.panels().active.get('name'), inp_val);
            return false;
        }
    },

    setCurrentTopic: function (new_topic) {
        new_topic = new_topic || '';

        // We only want a plain text version
        $('div', this.$el).html(formatIRCMsg(_.escape(new_topic)));
    },

    setCurrentTopicFromChannel: function(channel) {
        var set_by = channel.get('topic_set_by'),
            set_by_text = '';

        this.setCurrentTopic(channel.get("topic"));

        if (set_by) {
            set_by_text += translateText('client_models_network_topic', [set_by.nick, _kiwi.utils.formatDate(set_by.when)]);
            this.$el.attr('title', set_by_text);
        } else {
            this.$el.attr('title', '');
        }
    }
});


_kiwi.view.UserBox = Backbone.View.extend({
    events: {
        'click .query': 'queryClick',
        'click .info': 'infoClick',
        'change .ignore': 'ignoreChange',
        'click .ignore': 'ignoreClick',
        'click .op': 'opClick',
        'click .deop': 'deopClick',
        'click .voice': 'voiceClick',
        'click .devoice': 'devoiceClick',
        'click .kick': 'kickClick',
        'click .ban': 'banClick'
    },

    initialize: function () {
        var text = {
            op: _kiwi.global.i18n.translate('client_views_userbox_op').fetch(),
            de_op: _kiwi.global.i18n.translate('client_views_userbox_deop').fetch(),
            voice: _kiwi.global.i18n.translate('client_views_userbox_voice').fetch(),
            de_voice: _kiwi.global.i18n.translate('client_views_userbox_devoice').fetch(),
            kick: _kiwi.global.i18n.translate('client_views_userbox_kick').fetch(),
            ban: _kiwi.global.i18n.translate('client_views_userbox_ban').fetch(),
            message: _kiwi.global.i18n.translate('client_views_userbox_query').fetch(),
            info: _kiwi.global.i18n.translate('client_views_userbox_whois').fetch(),
            ignore: _kiwi.global.i18n.translate('client_views_userbox_ignore').fetch()
        };
        this.$el = $(_.template($('#tmpl_userbox').html().trim(), text));
    },

    setTargets: function (user, channel) {
        this.user = user;
        this.channel = channel;

        var is_ignored = _kiwi.app.connections.active_connection.isNickIgnored(this.user.get('nick'));
        this.$('.ignore input').attr('checked', is_ignored ? 'checked' : false);
    },

    displayOpItems: function(display_items) {
        if (display_items) {
            this.$el.find('.if_op').css('display', 'block');
        } else {
            this.$el.find('.if_op').css('display', 'none');
        }
    },

    queryClick: function (event) {
        var nick = this.user.get('nick');
        _kiwi.app.connections.active_connection.createQuery(nick);
    },

    infoClick: function (event) {
        _kiwi.app.controlbox.processInput('/whois ' + this.user.get('nick'));
    },

    ignoreClick: function (event) {
        // Stop the menubox from closing since it will not update the checkbox otherwise
        event.stopPropagation();
    },

    ignoreChange: function (event) {
        if ($(event.currentTarget).find('input').is(':checked')) {
            _kiwi.app.controlbox.processInput('/ignore ' + this.user.get('nick'));
        } else {
            _kiwi.app.controlbox.processInput('/unignore ' + this.user.get('nick'));
        }
    },

    opClick: function (event) {
        _kiwi.app.controlbox.processInput('/mode ' + this.channel.get('name') + ' +o ' + this.user.get('nick'));
    },

    deopClick: function (event) {
        _kiwi.app.controlbox.processInput('/mode ' + this.channel.get('name') + ' -o ' + this.user.get('nick'));
    },

    voiceClick: function (event) {
        _kiwi.app.controlbox.processInput('/mode ' + this.channel.get('name') + ' +v ' + this.user.get('nick'));
    },

    devoiceClick: function (event) {
        _kiwi.app.controlbox.processInput('/mode ' + this.channel.get('name') + ' -v ' + this.user.get('nick'));
    },

    kickClick: function (event) {
        // TODO: Enable the use of a custom kick message
        _kiwi.app.controlbox.processInput('/kick ' + this.user.get('nick') + ' Bye!');
    },

    banClick: function (event) {
        // TODO: Set ban on host, not just on nick
        _kiwi.app.controlbox.processInput('/mode ' + this.channel.get('name') + ' +b ' + this.user.get('nick') + '!*');
    }
});


_kiwi.view.ChannelTools = Backbone.View.extend({
    events: {
        'click .channel_info': 'infoClick',
        'click .channel_part': 'partClick'
    },

    initialize: function () {},

    infoClick: function (event) {
        new _kiwi.model.ChannelInfo({channel: _kiwi.app.panels().active});
    },

    partClick: function (event) {
        _kiwi.app.connections.active_connection.gateway.part(_kiwi.app.panels().active.get('name'));
    }
});


// var f = new _kiwi.model.ChannelInfo({channel: _kiwi.app.panels().active});

_kiwi.view.ChannelInfo = Backbone.View.extend({
    events: {
        'click .toggle_banlist': 'toggleBanList',
        'change .channel-mode': 'onModeChange',
        'click .remove-ban': 'onRemoveBanClick'
    },


    initialize: function () {
        var that = this,
            network,
            channel = this.model.get('channel'),
            text;

        text = {
            moderated_chat: translateText('client_views_channelinfo_moderated'),
            invite_only: translateText('client_views_channelinfo_inviteonly'),
            ops_change_topic: translateText('client_views_channelinfo_opschangechannel'),
            external_messages: translateText('client_views_channelinfo_externalmessages'),
            toggle_banlist: translateText('client_views_channelinfo_togglebanlist'),
            channel_name: channel.get('name')
        };

        this.$el = $(_.template($('#tmpl_channel_info').html().trim(), text));

        // Create the menu box this view will sit inside
        this.menu = new _kiwi.view.MenuBox(channel.get('name'));
        this.menu.addItem('channel_info', this.$el);
        this.menu.$el.appendTo(channel.view.$container);
        this.menu.show();

        this.menu.$el.offset({top: _kiwi.app.view.$el.find('.panels').offset().top});

        // Menu box will call this destroy on closing
        this.$el.dispose = _.bind(this.dispose, this);

        // Display the info we have, then listen for further changes
        this.updateInfo(channel);
        channel.on('change:info_modes change:info_url change:banlist', this.updateInfo, this);

        // Request the latest info for ths channel from the network
        channel.get('network').gateway.channelInfo(channel.get('name'));
    },


    render: function () {
    },


    onModeChange: function(event) {
        var $this = $(event.currentTarget),
            channel = this.model.get('channel'),
            mode = $this.data('mode'),
            mode_string = '';

        if ($this.attr('type') == 'checkbox') {
            mode_string = $this.is(':checked') ? '+' : '-';
            mode_string += mode;
            channel.setMode(mode_string);

            return;
        }

        if ($this.attr('type') == 'text') {
            mode_string = $this.val() ?
                '+' + mode + ' ' + $this.val() :
                '-' + mode;

            channel.setMode(mode_string);

            return;
        }
    },


    onRemoveBanClick: function (event) {
        event.preventDefault();
        event.stopPropagation();

        var $this = $(event.currentTarget),
            $tr = $this.parents('tr:first'),
            ban = $tr.data('ban');

        if (!ban)
            return;

        var channel = this.model.get('channel');
        channel.setMode('-b ' + ban.banned);

        $tr.remove();
    },


    updateInfo: function (channel, new_val) {
        var that = this,
            title, modes, url, banlist;

        modes = channel.get('info_modes');
        if (modes) {
            _.each(modes, function(mode, idx) {
                mode.mode = mode.mode.toLowerCase();

                if (mode.mode == '+k') {
                    that.$el.find('[name="channel_key"]').val(mode.param);
                } else if (mode.mode == '+m') {
                    that.$el.find('[name="channel_mute"]').attr('checked', 'checked');
                } else if (mode.mode == '+i') {
                    that.$el.find('[name="channel_invite"]').attr('checked', 'checked');
                } else if (mode.mode == '+n') {
                    that.$el.find('[name="channel_external_messages"]').attr('checked', 'checked');
                } else if (mode.mode == '+t') {
                    that.$el.find('[name="channel_topic"]').attr('checked', 'checked');
                }
            });
        }

        url = channel.get('info_url');
        if (url) {
            this.$el.find('.channel_url')
                .text(url)
                .attr('href', url);

            this.$el.find('.channel_url').slideDown();
        }

        banlist = channel.get('banlist');
        if (banlist && banlist.length) {
            var $table = this.$el.find('.channel-banlist table tbody');

            this.$el.find('.banlist-status').text('');

            $table.empty();
            _.each(banlist, function(ban) {
                var $tr = $('<tr></tr>').data('ban', ban);

                $('<td></td>').text(ban.banned).appendTo($tr);
                $('<td></td>').text(ban.banned_by.split(/[!@]/)[0]).appendTo($tr);
                $('<td></td>').text(_kiwi.utils.formatDate(new Date(parseInt(ban.banned_at, 10) * 1000))).appendTo($tr);
                $('<td><i class="fa fa-rtimes remove-ban"></i></td>').appendTo($tr);

                $table.append($tr);
            });

            this.$el.find('.channel-banlist table').slideDown();
        } else {
            this.$el.find('.banlist-status').text('Banlist empty');
            this.$el.find('.channel-banlist table').hide();
        }
    },

    toggleBanList: function (event) {
        event.preventDefault();
        this.$el.find('.channel-banlist table').toggle();

        if(!this.$el.find('.channel-banlist table').is(':visible'))
            return;

        var channel = this.model.get('channel'),
            network = channel.get('network');

        network.gateway.raw('MODE ' + channel.get('name') + ' +b');
    },

    dispose: function () {
        this.model.get('channel').off('change:info_modes change:info_url change:banlist', this.updateInfo, this);

        this.$el.remove();
    }
});



_kiwi.view.RightBar = Backbone.View.extend({
    events: {
        'click .right-bar-toggle': 'onClickToggle',
        'click .right-bar-toggle-inner': 'onClickToggle'
    },

    initialize: function() {
        this.keep_hidden = false;
        this.hidden = this.$el.hasClass('disabled');

        this.updateIcon();
    },


    hide: function() {
        this.hidden = true;
        this.$el.addClass('disabled');

        this.updateIcon();
    },


    show: function() {
        this.hidden = false;

        if (!this.keep_hidden)
            this.$el.removeClass('disabled');

        this.updateIcon();
    },


    // Toggle if the rightbar should be shown or not
    toggle: function(keep_hidden) {
        // Hacky, but we need to ignore the toggle() call from doLayout() as we are overriding it
        if (this.ignore_layout)
            return true;

        if (typeof keep_hidden === 'undefined') {
            this.keep_hidden = !this.keep_hidden;
        } else {
            this.keep_hidden = keep_hidden;
        }

        if (this.keep_hidden || this.hidden) {
            this.$el.addClass('disabled');
        } else {
            this.$el.removeClass('disabled');
        }

        this.updateIcon();
    },


    updateIcon: function() {
        var $toggle = this.$('.right-bar-toggle'),
            $icon = $toggle.find('i');

        if (!this.hidden && this.keep_hidden) {
            $toggle.show();
        } else {
            $toggle.hide();
        }

        if (this.keep_hidden) {
            $icon.removeClass('fa fa-angle-double-right').addClass('fa fa-users');
        } else {
            $icon.removeClass('fa fa-users').addClass('fa fa-angle-double-right');
        }
    },


    onClickToggle: function(event) {
        this.toggle();

        // Hacky, but we need to ignore the toggle() call from doLayout() as we are overriding it
        this.ignore_layout = true;
        _kiwi.app.view.doLayout();

        // No longer ignoring the toggle() call from doLayout()
        delete this.ignore_layout;
    }
});


_kiwi.view.Notification = Backbone.View.extend({
    className: 'notification',

    events: {
        'click .close': 'close'
    },

    initialize: function(title, content) {
        this.title = title;
        this.content = content;
    },

    render: function() {
        this.$el.html($('#tmpl_notifications').html());
        this.$('h6').text(this.title);

        // HTML string or jquery object
        if (typeof this.content === 'string') {
                this.$('.content').html(this.content);
            } else if (typeof this.content === 'object') {
                this.$('.content').empty().append(this.content);
            }

        return this;
    },

    show: function() {
        var that = this;

        this.render().$el.appendTo(_kiwi.app.view.$el);

        // The element won't have any CSS transitions applied
        // until after a tick + paint.
        _.defer(function() {
            that.$el.addClass('show');
        });
    },

    close: function() {
        this.remove();
    }
});


(function() {

    function ClientUiCommands(app, controlbox) {
        this.app = app;
        this.controlbox = controlbox;

        this.addDefaultAliases();
        this.bindCommand(fn_to_bind);
    }

    _kiwi.misc.ClientUiCommands = ClientUiCommands;


    // Add the default user command aliases
    ClientUiCommands.prototype.addDefaultAliases = function() {
        $.extend(this.controlbox.preprocessor.aliases, {
            // General aliases
            '/p':        '/part $1+',
            '/me':       '/action $1+',
            '/j':        '/join $1+',
            '/q':        '/query $1+',
            '/w':        '/whois $1+',
            '/raw':      '/quote $1+',
            '/connect':  '/server $1+',

            // Op related aliases
            '/op':       '/quote mode $channel +o $1+',
            '/deop':     '/quote mode $channel -o $1+',
            '/hop':      '/quote mode $channel +h $1+',
            '/dehop':    '/quote mode $channel -h $1+',
            '/voice':    '/quote mode $channel +v $1+',
            '/devoice':  '/quote mode $channel -v $1+',
            '/k':        '/kick $channel $1+',
            '/ban':      '/quote mode $channel +b $1+',
            '/unban':    '/quote mode $channel -b $1+',

            // Misc aliases
            '/slap':     '/me slaps $1 around a bit with a large trout',
            '/tick':     '/msg $channel ✔'
        });
    };


    /**
     * Add a new command action
     * @var command Object {'command:the_command': fn}
     */
    ClientUiCommands.prototype.bindCommand = function(command) {
        var that = this;

        _.each(command, function(fn, event_name) {
            that.controlbox.on(event_name, _.bind(fn, that));
        });
    };




    /**
     * Default functions to bind to controlbox events
     **/

    var fn_to_bind = {
        'unknown_command':     unknownCommand,
        'command':             allCommands,
        'command:msg':         msgCommand,
        'command:action':      actionCommand,
        'command:join':        joinCommand,
        'command:part':        partCommand,
        'command:cycle':        cycleCommand,
        'command:nick':        nickCommand,
        'command:query':       queryCommand,
        'command:invite':      inviteCommand,
        'command:topic':       topicCommand,
        'command:notice':      noticeCommand,
        'command:quote':       quoteCommand,
        'command:kick':        kickCommand,
        'command:clear':       clearCommand,
        'command:ctcp':        ctcpCommand,
        'command:quit':        quitCommand,
        'command:server':      serverCommand,
        'command:whois':       whoisCommand,
        'command:whowas':      whowasCommand,
        'command:away':        awayCommand,
        'command:encoding':    encodingCommand,
        'command:channel':     channelCommand,
        'command:applet':      appletCommand,
        'command:settings':    settingsCommand,
        'command:script':      scriptCommand
    };


    fn_to_bind['command:css'] = function (ev) {
        var queryString = '?reload=' + new Date().getTime();
        $('link[rel="stylesheet"]').each(function () {
            this.href = this.href.replace(/\?.*|$/, queryString);
        });
    };


    fn_to_bind['command:js'] = function (ev) {
        if (!ev.params[0]) return;
        $script(ev.params[0] + '?' + (new Date().getTime()));
    };


    fn_to_bind['command:set'] = function (ev) {
        if (!ev.params[0]) return;

        var setting = ev.params[0],
            value;

        // Do we have a second param to set a value?
        if (ev.params[1]) {
            ev.params.shift();

            value = ev.params.join(' ');

            // If we're setting a true boolean value..
            if (value === 'true')
                value = true;

            // If we're setting a false boolean value..
            if (value === 'false')
                value = false;

            // If we're setting a number..
            if (parseInt(value, 10).toString() === value)
                value = parseInt(value, 10);

            _kiwi.global.settings.set(setting, value);
        }

        // Read the value to the user
        this.app.panels().active.addMsg('', styleText('set_setting', {text: setting + ' = ' + _kiwi.global.settings.get(setting).toString()}));
    };


    fn_to_bind['command:save'] = function (ev) {
        _kiwi.global.settings.save();
        this.app.panels().active.addMsg('', styleText('settings_saved', {text: translateText('client_models_application_settings_saved')}));
    };


    fn_to_bind['command:alias'] = function (ev) {
        var that = this,
            name, rule;

        // No parameters passed so list them
        if (!ev.params[1]) {
            $.each(this.controlbox.preprocessor.aliases, function (name, rule) {
                that.app.panels().server.addMsg(' ', styleText('list_aliases', {text: name + '   =>   ' + rule}));
            });
            return;
        }

        // Deleting an alias?
        if (ev.params[0] === 'del' || ev.params[0] === 'delete') {
            name = ev.params[1];
            if (name[0] !== '/') name = '/' + name;
            delete this.controlbox.preprocessor.aliases[name];
            return;
        }

        // Add the alias
        name = ev.params[0];
        ev.params.shift();
        rule = ev.params.join(' ');

        // Make sure the name starts with a slash
        if (name[0] !== '/') name = '/' + name;

        // Now actually add the alias
        this.controlbox.preprocessor.aliases[name] = rule;
    };


    fn_to_bind['command:ignore'] = function (ev) {
        var that = this,
            list = this.app.connections.active_connection.get('ignore_list');

        // No parameters passed so list them
        if (!ev.params[0]) {
            if (list.length > 0) {
                this.app.panels().active.addMsg(' ', styleText('ignore_title', {text: translateText('client_models_application_ignore_title')}));
                $.each(list, function (idx, ignored_pattern) {
                    that.app.panels().active.addMsg(' ', styleText('ignored_pattern', {text: ignored_pattern}));
                });
            } else {
                this.app.panels().active.addMsg(' ', styleText('ignore_none', {text: translateText('client_models_application_ignore_none')}));
            }
            return;
        }

        // We have a parameter, so add it
        list.push(ev.params[0]);
        this.app.connections.active_connection.set('ignore_list', list);
        this.app.panels().active.addMsg(' ', styleText('ignore_nick', {text: translateText('client_models_application_ignore_nick', [ev.params[0]])}));
    };


    fn_to_bind['command:unignore'] = function (ev) {
        var list = this.app.connections.active_connection.get('ignore_list');

        if (!ev.params[0]) {
            this.app.panels().active.addMsg(' ', styleText('ignore_stop_notice', {text: translateText('client_models_application_ignore_stop_notice')}));
            return;
        }

        list = _.reject(list, function(pattern) {
            return pattern === ev.params[0];
        });

        this.app.connections.active_connection.set('ignore_list', list);

        this.app.panels().active.addMsg(' ', styleText('ignore_stopped', {text: translateText('client_models_application_ignore_stopped', [ev.params[0]])}));
    };




    // A fallback action. Send a raw command to the server
    function unknownCommand (ev) {
        var raw_cmd = ev.command + ' ' + ev.params.join(' ');
        this.app.connections.active_connection.gateway.raw(raw_cmd);
    }


    function allCommands (ev) {}


    function joinCommand (ev) {
        var panels, channel_names;

        channel_names = ev.params.join(' ').split(',');
        panels = this.app.connections.active_connection.createAndJoinChannels(channel_names);

        // Show the last channel if we have one
        if (panels.length)
            panels[panels.length - 1].view.show();
    }


    function queryCommand (ev) {
        var destination, message, panel;

        destination = ev.params[0];
        ev.params.shift();

        message = ev.params.join(' ');

        // Check if we have the panel already. If not, create it
        panel = this.app.connections.active_connection.panels.getByName(destination);
        if (!panel) {
            panel = new _kiwi.model.Query({name: destination});
            this.app.connections.active_connection.panels.add(panel);
        }

        if (panel) panel.view.show();

        if (message) {
            this.app.connections.active_connection.gateway.msg(panel.get('name'), message);
            panel.addMsg(this.app.connections.active_connection.get('nick'), styleText('privmsg', {text: message}), 'privmsg');
        }

    }


    function msgCommand (ev) {
        var message,
            destination = ev.params[0],
            panel = this.app.connections.active_connection.panels.getByName(destination) || this.app.panels().server;

        ev.params.shift();
        message = ev.params.join(' ');

        panel.addMsg(this.app.connections.active_connection.get('nick'), styleText('privmsg', {text: message}), 'privmsg');
        this.app.connections.active_connection.gateway.msg(destination, message);
    }


    function actionCommand (ev) {
        if (this.app.panels().active.isServer()) {
            return;
        }

        var panel = this.app.panels().active;
        panel.addMsg('', styleText('action', {nick: this.app.connections.active_connection.get('nick'), text: ev.params.join(' ')}), 'action');
        this.app.connections.active_connection.gateway.action(panel.get('name'), ev.params.join(' '));
    }


    function partCommand (ev) {
        var that = this,
            chans,
            msg;
        if (ev.params.length === 0) {
            this.app.connections.active_connection.gateway.part(this.app.panels().active.get('name'));
        } else {
            chans = ev.params[0].split(',');
            msg = ev.params[1];
            _.each(chans, function (channel) {
                that.connections.active_connection.gateway.part(channel, msg);
            });
        }
    }


    function cycleCommand (ev) {
        var that = this,
            chan_name;

        if (ev.params.length === 0) {
            chan_name = this.app.panels().active.get('name');
        } else {
            chan_name = ev.params[0];
        }

        this.app.connections.active_connection.gateway.part(chan_name);

        // Wait for a second to give the network time to register the part command
        setTimeout(function() {
            // Use createAndJoinChannels() here as it auto-creates panels instead of waiting for the network
            that.app.connections.active_connection.createAndJoinChannels(chan_name);
            that.app.connections.active_connection.panels.getByName(chan_name).show();
        }, 1000);
    }


    function nickCommand (ev) {
        this.app.connections.active_connection.gateway.changeNick(ev.params[0]);
    }


    function topicCommand (ev) {
        var channel_name;

        if (ev.params.length === 0) return;

        if (this.app.connections.active_connection.isChannelName(ev.params[0])) {
            channel_name = ev.params[0];
            ev.params.shift();
        } else {
            channel_name = this.app.panels().active.get('name');
        }

        this.app.connections.active_connection.gateway.topic(channel_name, ev.params.join(' '));
    }


    function noticeCommand (ev) {
        var destination;

        // Make sure we have a destination and some sort of message
        if (ev.params.length <= 1) return;

        destination = ev.params[0];
        ev.params.shift();

        this.app.connections.active_connection.gateway.notice(destination, ev.params.join(' '));
    }


    function quoteCommand (ev) {
        var raw = ev.params.join(' ');
        this.app.connections.active_connection.gateway.raw(raw);
    }


    function kickCommand (ev) {
        var nick, panel = this.app.panels().active;

        if (!panel.isChannel()) return;

        // Make sure we have a nick
        if (ev.params.length === 0) return;

        nick = ev.params[0];
        ev.params.shift();

        this.app.connections.active_connection.gateway.kick(panel.get('name'), nick, ev.params.join(' '));
    }


    function clearCommand (ev) {
        // Can't clear a server or applet panel
        if (this.app.panels().active.isServer() || this.app.panels().active.isApplet()) {
            return;
        }

        if (this.app.panels().active.clearMessages) {
            this.app.panels().active.clearMessages();
        }
    }


    function ctcpCommand(ev) {
        var target, type;

        // Make sure we have a target and a ctcp type (eg. version, time)
        if (ev.params.length < 2) return;

        target = ev.params[0];
        ev.params.shift();

        type = ev.params[0];
        ev.params.shift();

        this.app.connections.active_connection.gateway.ctcpRequest(type, target, ev.params.join(' '));
    }


    function settingsCommand (ev) {
        var settings = _kiwi.model.Applet.loadOnce('kiwi_settings');
        settings.view.show();
    }


    function scriptCommand (ev) {
        var editor = _kiwi.model.Applet.loadOnce('kiwi_script_editor');
        editor.view.show();
    }


    function appletCommand (ev) {
        if (!ev.params[0]) return;

        var panel = new _kiwi.model.Applet();

        if (ev.params[1]) {
            // Url and name given
            panel.load(ev.params[0], ev.params[1]);
        } else {
            // Load a pre-loaded applet
            if (this.applets[ev.params[0]]) {
                panel.load(new this.applets[ev.params[0]]());
            } else {
                this.app.panels().server.addMsg('', styleText('applet_notfound', {text: translateText('client_models_application_applet_notfound', [ev.params[0]])}));
                return;
            }
        }

        this.app.connections.active_connection.panels.add(panel);
        panel.view.show();
    }


    function inviteCommand (ev) {
        var nick, channel;

        // A nick must be specified
        if (!ev.params[0])
            return;

        // Can only invite into channels
        if (!this.app.panels().active.isChannel())
            return;

        nick = ev.params[0];
        channel = this.app.panels().active.get('name');

        this.app.connections.active_connection.gateway.raw('INVITE ' + nick + ' ' + channel);

        this.app.panels().active.addMsg('', styleText('channel_has_been_invited', {nick: nick, text: translateText('client_models_application_has_been_invited', [channel])}), 'action');
    }


    function whoisCommand (ev) {
        var nick;

        if (ev.params[0]) {
            nick = ev.params[0];
        } else if (this.app.panels().active.isQuery()) {
            nick = this.app.panels().active.get('name');
        }

        if (nick)
            this.app.connections.active_connection.gateway.raw('WHOIS ' + nick + ' ' + nick);
    }


    function whowasCommand (ev) {
        var nick;

        if (ev.params[0]) {
            nick = ev.params[0];
        } else if (this.app.panels().active.isQuery()) {
            nick = this.app.panels().active.get('name');
        }

        if (nick)
            this.app.connections.active_connection.gateway.raw('WHOWAS ' + nick);
    }


    function awayCommand (ev) {
        this.app.connections.active_connection.gateway.raw('AWAY :' + ev.params.join(' '));
    }


    function encodingCommand (ev) {
        var that = this;

        if (ev.params[0]) {
            _kiwi.gateway.setEncoding(null, ev.params[0], function (success) {
                if (success) {
                    that.app.panels().active.addMsg('', styleText('encoding_changed', {text: translateText('client_models_application_encoding_changed', [ev.params[0]])}));
                } else {
                    that.app.panels().active.addMsg('', styleText('encoding_invalid', {text: translateText('client_models_application_encoding_invalid', [ev.params[0]])}));
                }
            });
        } else {
            this.app.panels().active.addMsg('', styleText('client_models_application_encoding_notspecified', {text: translateText('client_models_application_encoding_notspecified')}));
            this.app.panels().active.addMsg('', styleText('client_models_application_encoding_usage', {text: translateText('client_models_application_encoding_usage')}));
        }
    }


    function channelCommand (ev) {
        var active_panel = this.app.panels().active;

        if (!active_panel.isChannel())
            return;

        new _kiwi.model.ChannelInfo({channel: this.app.panels().active});
    }


    function quitCommand (ev) {
        var network = this.app.connections.active_connection;

        if (!network)
            return;

        network.gateway.quit(ev.params.join(' '));
    }


    function serverCommand (ev) {
        var that = this,
            server, port, ssl, password, nick,
            tmp;

        // If no server address given, show the new connection dialog
        if (!ev.params[0]) {
            tmp = new _kiwi.view.MenuBox(_kiwi.global.i18n.translate('client_models_application_connection_create').fetch());
            tmp.addItem('new_connection', new _kiwi.model.NewConnection().view.$el);
            tmp.show();

            // Center screen the dialog
            tmp.$el.offset({
                top: (this.app.view.$el.height() / 2) - (tmp.$el.height() / 2),
                left: (this.app.view.$el.width() / 2) - (tmp.$el.width() / 2)
            });

            return;
        }

        // Port given in 'host:port' format and no specific port given after a space
        if (ev.params[0].indexOf(':') > 0) {
            tmp = ev.params[0].split(':');
            server = tmp[0];
            port = tmp[1];

            password = ev.params[1] || undefined;

        } else {
            // Server + port given as 'host port'
            server = ev.params[0];
            port = ev.params[1] || 6667;

            password = ev.params[2] || undefined;
        }

        // + in the port means SSL
        if (port.toString()[0] === '+') {
            ssl = true;
            port = parseInt(port.substring(1), 10);
        } else {
            ssl = false;
        }

        // Default port if one wasn't found
        port = port || 6667;

        // Use the same nick as we currently have
        nick = this.app.connections.active_connection.get('nick');

        this.app.panels().active.addMsg('', styleText('server_connecting', {text: translateText('client_models_application_connection_connecting', [server, port.toString()])}));

        _kiwi.gateway.newConnection({
            nick: nick,
            host: server,
            port: port,
            ssl: ssl,
            password: password
        }, function(err, new_connection) {
            var translated_err;

            if (err) {
                translated_err = translateText('client_models_application_connection_error', [server, port.toString(), err.toString()]);
                that.app.panels().active.addMsg('', styleText('server_connecting_error', {text: translated_err}));
            }
        });
    }

})();


(function () {
    var View = Backbone.View.extend({
        events: {
            'change [data-setting]': 'saveSettings',
            'click [data-setting="theme"]': 'selectTheme',
            'click .register_protocol': 'registerProtocol',
            'click .enable_notifications': 'enableNotifications'
        },

        initialize: function (options) {
            var text = {
                tabs                  : translateText('client_applets_settings_channelview_tabs'),
                list                  : translateText('client_applets_settings_channelview_list'),
                large_amounts_of_chans: translateText('client_applets_settings_channelview_list_notice'),
                join_part             : translateText('client_applets_settings_notification_joinpart'),
                count_all_activity    : translateText('client_applets_settings_notification_count_all_activity'),
                timestamps            : translateText('client_applets_settings_timestamp'),
                timestamp_24          : translateText('client_applets_settings_timestamp_24_hour'),
                mute                  : translateText('client_applets_settings_notification_sound'),
                emoticons             : translateText('client_applets_settings_emoticons'),
                scroll_history        : translateText('client_applets_settings_history_length'),
                languages             : _kiwi.app.translations,
                default_client        : translateText('client_applets_settings_default_client'),
                make_default          : translateText('client_applets_settings_default_client_enable'),
                locale_restart_needed : translateText('client_applets_settings_locale_restart_needed'),
                default_note          : translateText('client_applets_settings_default_client_notice', '<a href="chrome://settings/handlers">chrome://settings/handlers</a>'),
                html5_notifications   : translateText('client_applets_settings_html5_notifications'),
                enable_notifications  : translateText('client_applets_settings_enable_notifications'),
                custom_highlights     : translateText('client_applets_settings_custom_highlights'),
                theme_thumbnails: _.map(_kiwi.app.themes, function (theme) {
                    return _.template($('#tmpl_theme_thumbnail').html().trim(), theme);
                })
            };
            this.$el = $(_.template($('#tmpl_applet_settings').html().trim(), text));

            if (!navigator.registerProtocolHandler) {
                this.$('.protocol_handler').remove();
            }

            if (_kiwi.utils.notifications.allowed() !== null) {
                this.$('.notification_enabler').remove();
            }

            // Incase any settings change while we have this open, update them
            _kiwi.global.settings.on('change', this.loadSettings, this);

            // Now actually show the current settings
            this.loadSettings();

        },

        loadSettings: function () {

            _.each(_kiwi.global.settings.attributes, function(value, key) {

                var $el = this.$('[data-setting="' + key + '"]');

                // Only deal with settings we have a UI element for
                if (!$el.length)
                    return;

                switch ($el.prop('type')) {
                    case 'checkbox':
                        $el.prop('checked', value);
                        break;
                    case 'radio':
                        this.$('[data-setting="' + key + '"][value="' + value + '"]').prop('checked', true);
                        break;
                    case 'text':
                        $el.val(value);
                        break;
                    case 'select-one':
                        this.$('[value="' + value + '"]').prop('selected', true);
                        break;
                    default:
                        this.$('[data-setting="' + key + '"][data-value="' + value + '"]').addClass('active');
                        break;
                }
            }, this);
        },

        saveSettings: function (event) {
            var value,
                settings = _kiwi.global.settings,
                $setting = $(event.currentTarget);

            switch (event.currentTarget.type) {
                case 'checkbox':
                    value = $setting.is(':checked');
                    break;
                case 'radio':
                case 'text':
                    value = $setting.val();
                    break;
                case 'select-one':
                    value = $(event.currentTarget[$setting.prop('selectedIndex')]).val();
                    break;
                default:
                    value = $setting.data('value');
                    break;
            }

            // Stop settings being updated while we're saving one by one
            _kiwi.global.settings.off('change', this.loadSettings, this);
            settings.set($setting.data('setting'), value);
            settings.save();

            // Continue listening for setting changes
            _kiwi.global.settings.on('change', this.loadSettings, this);
        },

        selectTheme: function(event) {
            event.preventDefault();

            this.$('[data-setting="theme"].active').removeClass('active');
            $(event.currentTarget).addClass('active').trigger('change');
        },

        registerProtocol: function (event) {
            event.preventDefault();

            navigator.registerProtocolHandler('irc', document.location.origin + _kiwi.app.get('base_path') + '/%s', 'Kiwi IRC');
            navigator.registerProtocolHandler('ircs', document.location.origin + _kiwi.app.get('base_path') + '/%s', 'Kiwi IRC');
        },

        enableNotifications: function(event){
            event.preventDefault();
            var notifications = _kiwi.utils.notifications;

            notifications.requestPermission().always(_.bind(function () {
                if (notifications.allowed() !== null) {
                    this.$('.notification_enabler').remove();
                }
            }, this));
        }

    });


    var Applet = Backbone.Model.extend({
        initialize: function () {
            this.set('title', translateText('client_applets_settings_title'));
            this.view = new View();
        }
    });


    _kiwi.model.Applet.register('kiwi_settings', Applet);
})();



(function () {

    var View = Backbone.View.extend({
        events: {
            "click .chan": "chanClick",
            "click .channel_name_title": "sortChannelsByNameClick",
            "click .users_title": "sortChannelsByUsersClick"
        },



        initialize: function (options) {
            var text = {
                channel_name: _kiwi.global.i18n.translate('client_applets_chanlist_channelname').fetch(),
                users: _kiwi.global.i18n.translate('client_applets_chanlist_users').fetch(),
                topic: _kiwi.global.i18n.translate('client_applets_chanlist_topic').fetch()
            };
            this.$el = $(_.template($('#tmpl_channel_list').html().trim(), text));

            this.channels = [];

            // Sort the table
            this.order = '';

            // Waiting to add the table back into the DOM?
            this.waiting = false;
        },

        render: function () {
            var table = $('table', this.$el),
                tbody = table.children('tbody:first').detach(),
                that = this,
                i;

            // Create the sort icon container and clean previous any previous ones
            if($('.applet_chanlist .users_title').find('span.chanlist_sort_users').length == 0) {
                this.$('.users_title').append('<span class="chanlist_sort_users">&nbsp;&nbsp;</span>');
            } else {
                this.$('.users_title span.chanlist_sort_users').removeClass('fa fa-sort-desc');
                this.$('.users_title span.chanlist_sort_users').removeClass('fa fa-sort-asc');
            }
            if ($('.applet_chanlist .channel_name_title').find('span.chanlist_sort_names').length == 0) {
                this.$('.channel_name_title').append('<span class="chanlist_sort_names">&nbsp;&nbsp;</span>');
            } else {
                this.$('.channel_name_title span.chanlist_sort_names').removeClass('fa fa-sort-desc');
                this.$('.channel_name_title span.chanlist_sort_names').removeClass('fa fa-sort-asc');
            }

            // Push the new sort icon
            switch (this.order) {
                case 'user_desc':
                default:
                    this.$('.users_title span.chanlist_sort_users').addClass('fa fa-sort-asc');
                    break;
                case 'user_asc':
                    this.$('.users_title span.chanlist_sort_users').addClass('fa fa-sort-desc');
                    break;
                case 'name_asc':
                    this.$('.channel_name_title span.chanlist_sort_names').addClass('fa fa-sort-desc');
                    break;
                case 'name_desc':
                    this.$('.channel_name_title span.chanlist_sort_names').addClass('fa fa-sort-asc');
                    break;
            }

            this.channels = this.sortChannels(this.channels, this.order);

            // Make sure all the channel DOM nodes are inserted in order
            for (i = 0; i < this.channels.length; i++) {
                tbody[0].appendChild(this.channels[i].dom);
            }

            table[0].appendChild(tbody[0]);
        },


        chanClick: function (event) {
            if (event.target) {
                _kiwi.gateway.join(null, $(event.target).data('channel'));
            } else {
                // IE...
                _kiwi.gateway.join(null, $(event.srcElement).data('channel'));
            }
        },

        sortChannelsByNameClick: function (event) {
            // Revert the sorting to switch between orders
            this.order = (this.order == 'name_asc') ? 'name_desc' : 'name_asc';

            this.sortChannelsClick();
        },

        sortChannelsByUsersClick: function (event) {
            // Revert the sorting to switch between orders
            this.order = (this.order == 'user_desc' || this.order == '') ? 'user_asc' : 'user_desc';

            this.sortChannelsClick();
        },

        sortChannelsClick: function() {
            this.render();
        },

        sortChannels: function (channels, order) {
            var sort_channels = [],
                new_channels = [];


            // First we create a light copy of the channels object to do the sorting
            _.each(channels, function (chan, chan_idx) {
                sort_channels.push({'chan_idx': chan_idx, 'num_users': chan.num_users, 'channel': chan.channel});
            });

            // Second, we apply the sorting
            sort_channels.sort(function (a, b) {
                switch (order) {
                    case 'user_asc':
                        return a.num_users - b.num_users;
                    case 'user_desc':
                        return b.num_users - a.num_users;
                    case 'name_asc':
                        if (a.channel.toLowerCase() > b.channel.toLowerCase()) return 1;
                        if (a.channel.toLowerCase() < b.channel.toLowerCase()) return -1;
                    case 'name_desc':
                        if (a.channel.toLowerCase() < b.channel.toLowerCase()) return 1;
                        if (a.channel.toLowerCase() > b.channel.toLowerCase()) return -1;
                    default:
                        return b.num_users - a.num_users;
                }
                return 0;
            });

            // Third, we re-shuffle the chanlist according to the sort order
            _.each(sort_channels, function (chan) {
                new_channels.push(channels[chan.chan_idx]);
            });

            return new_channels;
        }
    });



    var Applet = Backbone.Model.extend({
        initialize: function () {
            this.set('title', _kiwi.global.i18n.translate('client_applets_chanlist_channellist').fetch());
            this.view = new View();

            this.network = _kiwi.global.components.Network();
            this.network.on('list_channel', this.onListChannel, this);
            this.network.on('list_start', this.onListStart, this);
        },


        // New channels to add to our list
        onListChannel: function (event) {
            this.addChannel(event.chans);
        },

        // A new, fresh channel list starting
        onListStart: function (event) {
            // TODO: clear out our existing list
        },

        addChannel: function (channels) {
            var that = this;

            if (!_.isArray(channels)) {
                channels = [channels];
            }
            _.each(channels, function (chan) {
                var row;
                row = document.createElement("tr");
                row.innerHTML = '<td class="chanlist_name"><a class="chan" data-channel="' + chan.channel + '">' + _.escape(chan.channel) + '</a></td><td class="chanlist_num_users" style="text-align: center;">' + chan.num_users + '</td><td style="padding-left: 2em;" class="chanlist_topic">' + formatIRCMsg(_.escape(chan.topic)) + '</td>';
                chan.dom = row;
                that.view.channels.push(chan);
            });

            if (!that.view.waiting) {
                that.view.waiting = true;
                _.defer(function () {
                    that.view.render();
                    that.view.waiting = false;
                });
            }
        },


        dispose: function () {
            this.view.channels = null;
            this.view.unbind();
            this.view.$el.html('');
            this.view.remove();
            this.view = null;

            // Remove any network event bindings
            this.network.off();
        }
    });



    _kiwi.model.Applet.register('kiwi_chanlist', Applet);
})();


    (function () {
        var view = Backbone.View.extend({
            events: {
                'click .btn_save': 'onSave'
            },

            initialize: function (options) {
                var that = this,
                    text = {
                        save: _kiwi.global.i18n.translate('client_applets_scripteditor_save').fetch()
                    };
                this.$el = $(_.template($('#tmpl_script_editor').html().trim(), text));

                this.model.on('applet_loaded', function () {
                    that.$el.parent().css('height', '100%');
                    $script(_kiwi.app.get('base_path') + '/assets/libs/ace/ace.js', function (){ that.createAce(); });
                });
            },


            createAce: function () {
                var editor_id = 'editor_' + Math.floor(Math.random()*10000000).toString();
                this.editor_id = editor_id;

                this.$el.find('.editor').attr('id', editor_id);

                this.editor = ace.edit(editor_id);
                this.editor.setTheme("ace/theme/monokai");
                this.editor.getSession().setMode("ace/mode/javascript");

                var script_content = _kiwi.global.settings.get('user_script') || '';
                this.editor.setValue(script_content);
            },


            onSave: function (event) {
                var script_content, user_fn;

                // Build the user script up with some pre-defined components
                script_content = 'var network = kiwi.components.Network();\n';
                script_content += 'var input = kiwi.components.ControlInput();\n';
                script_content += 'var events = kiwi.components.Events();\n';
                script_content += this.editor.getValue() + '\n';

                // Add a dispose method to the user script for cleaning up
                script_content += 'this._dispose = function(){ network.off(); input.off(); events.dispose(); if(this.dispose) this.dispose(); }';

                // Try to compile the user script
                try {
                    user_fn = new Function(script_content);

                    // Dispose any existing user script
                    if (_kiwi.user_script && _kiwi.user_script._dispose)
                        _kiwi.user_script._dispose();

                    // Create and run the new user script
                    _kiwi.user_script = new user_fn();

                } catch (err) {
                    this.setStatus(_kiwi.global.i18n.translate('client_applets_scripteditor_error').fetch(err.toString()));
                    return;
                }

                // If we're this far, no errors occured. Save the user script
                _kiwi.global.settings.set('user_script', this.editor.getValue());
                _kiwi.global.settings.save();

                this.setStatus(_kiwi.global.i18n.translate('client_applets_scripteditor_saved').fetch() + ' :)');
            },


            setStatus: function (status_text) {
                var $status = this.$el.find('.toolbar .status');

                status_text = status_text || '';
                $status.slideUp('fast', function() {
                    $status.text(status_text);
                    $status.slideDown();
                });
            }
        });



        var applet = Backbone.Model.extend({
            initialize: function () {
                var that = this;

                this.set('title', _kiwi.global.i18n.translate('client_applets_scripteditor_title').fetch());
                this.view = new view({model: this});

            }
        });


        _kiwi.model.Applet.register('kiwi_script_editor', applet);
        //_kiwi.model.Applet.loadOnce('kiwi_script_editor');
    })();


(function () {
    var view = Backbone.View.extend({
        events: {},


        initialize: function (options) {
            this.showConnectionDialog();
        },


        showConnectionDialog: function() {
            var connection_dialog = this.connection_dialog = new _kiwi.model.NewConnection();
            connection_dialog.populateDefaultServerSettings();

            connection_dialog.view.$el.addClass('initial');
            this.$el.append(connection_dialog.view.$el);

            var $info = $($('#tmpl_new_connection_info').html().trim());

            if ($info.html()) {
                connection_dialog.view.infoBoxSet($info);
            } else {
                $info = null;
            }

            this.listenTo(connection_dialog, 'connected', this.newConnectionConnected);

            _.defer(function(){
                if ($info) {
                    connection_dialog.view.infoBoxShow();
                }

                // Only set focus if we're not within an iframe. (firefox auto scrolls to the embedded client on page load - bad)
                if (window == window.top) {
                    connection_dialog.view.$el.find('.nick').select();
                }
            });
        },


        newConnectionConnected: function(network) {
            // Once connected, reset the connection form to be used again in future
            this.connection_dialog.view.reset();
        }
    });



    var applet = Backbone.Model.extend({
        initialize: function () {
            this.view = new view({model: this});
        }
    });


    _kiwi.model.Applet.register('kiwi_startup', applet);
})();



_kiwi.utils.notifications = (function () {
    if (!window.Notification) {
        return {
            allowed: _.constant(false),
            requestPermission: _.constant($.Deferred().reject())
        };
    }

    var notifications = {
        /**
         * Check if desktop notifications have been allowed by the user.
         *
         * @returns {?Boolean} `true`  - they have been allowed.
         *                     `false` - they have been blocked.
         *                     `null`  - the user hasn't answered yet.
         */
        allowed: function () {
            return Notification.permission === 'granted' ? true
                 : Notification.permission === 'denied' ? false
                 : null;
        },

        /**
         * Ask the user their permission to display desktop notifications.
         * This will return a promise which will be resolved if the user allows notifications, or rejected if they blocked
         * notifictions or simply closed the dialog. If the user had previously given their preference, the promise will be
         * immediately resolved or rejected with their previous answer.
         *
         * @example
         *   notifications.requestPermission().then(function () { 'allowed' }, function () { 'not allowed' });
         *
         * @returns {Promise}
         */
        requestPermission: function () {
            var deferred = $.Deferred();
            Notification.requestPermission(function (permission) {
                deferred[(permission === 'granted') ? 'resolve' : 'reject']();
            });
            return deferred.promise();
        },

        /**
         * Create a new notification. If the user has not yet given permission to display notifications, they will be asked
         * to confirm first. The notification will show afterwards if they allow it.
         *
         * Notifications implement Backbone.Events (so you can use `on` and `off`). They trigger four different events:
         *   - 'click'
         *   - 'close'
         *   - 'error'
         *   - 'show'
         *
         * @example
         *   notifications
         *     .create('Cool notification', { icon: 'logo.png' })
         *     .on('click', function () {
         *       window.focus();
         *     })
         *     .closeAfter(5000);
         *
         * @param   {String}  title
         * @param   {Object}  options
         * @param   {String=} options.body  A string representing an extra content to display within the notification
         * @param   {String=} options.dir   The direction of the notification; it can be auto, ltr, or rtl
         * @param   {String=} options.lang  Specify the lang used within the notification. This string must be a valid BCP
         *                                  47 language tag.
         * @param   {String=} options.tag   An ID for a given notification that allows to retrieve, replace or remove it if necessary
         * @param   {String=} options.icon  The URL of an image to be used as an icon by the notification
         * @returns {Notifier}
         */
        create: function (title, options) {
            return new Notifier(title, options);
        }
    };

    function Notifier(title, options) {
        createNotification.call(this, title, options);
    }
    _.extend(Notifier.prototype, Backbone.Events, {
        closed: false,
        _closeTimeout: null,

        /**
         * Close the notification after a given number of milliseconds.
         * @param   {Number} timeout
         * @returns {this}
         */
        closeAfter: function (timeout) {
            if (!this.closed) {
                if (this.notification) {
                    this._closeTimeout = this._closeTimeout || setTimeout(_.bind(this.close, this), timeout);
                } else {
                    this.once('show', _.bind(this.closeAfter, this, timeout));
                }
            }
            return this;
        },

        /**
         * Close the notification immediately.
         * @returns {this}
         */
        close: function () {
            if (this.notification && !this.closed) {
                this.notification.close();
                this.closed = true;
            }
            return this;
        }
    });

    function createNotification(title, options) {
        switch (notifications.allowed()) {
            case true:
                this.notification = new Notification(title, options);
                _.each(['click', 'close', 'error', 'show'], function (eventName) {
                    this.notification['on' + eventName] = _.bind(this.trigger, this, eventName);
                }, this);
                break;
            case null:
                notifications.requestPermission().done(_.bind(createNotification, this, title, options));
                break;
        }
    }

    return notifications;
}());



_kiwi.utils.formatDate = (function() {
    /*
    Modified version of date.format.js
    https://github.com/jacwright/date.format
    */
    var locale_init = false, // Once the loales have been loaded, this is set to true
        shortMonths, longMonths, shortDays, longDays;

    // defining patterns
    var replaceChars = {
        // Day
        d: function() { return (this.getDate() < 10 ? '0' : '') + this.getDate(); },
        D: function() { return Date.shortDays[this.getDay()]; },
        j: function() { return this.getDate(); },
        l: function() { return Date.longDays[this.getDay()]; },
        N: function() { return this.getDay() + 1; },
        S: function() { return (this.getDate() % 10 == 1 && this.getDate() != 11 ? 'st' : (this.getDate() % 10 == 2 && this.getDate() != 12 ? 'nd' : (this.getDate() % 10 == 3 && this.getDate() != 13 ? 'rd' : 'th'))); },
        w: function() { return this.getDay(); },
        z: function() { var d = new Date(this.getFullYear(),0,1); return Math.ceil((this - d) / 86400000); }, // Fixed now
        // Week
        W: function() { var d = new Date(this.getFullYear(), 0, 1); return Math.ceil((((this - d) / 86400000) + d.getDay() + 1) / 7); }, // Fixed now
        // Month
        F: function() { return Date.longMonths[this.getMonth()]; },
        m: function() { return (this.getMonth() < 9 ? '0' : '') + (this.getMonth() + 1); },
        M: function() { return Date.shortMonths[this.getMonth()]; },
        n: function() { return this.getMonth() + 1; },
        t: function() { var d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 0).getDate(); }, // Fixed now, gets #days of date
        // Year
        L: function() { var year = this.getFullYear(); return (year % 400 == 0 || (year % 100 != 0 && year % 4 == 0)); },   // Fixed now
        o: function() { var d  = new Date(this.valueOf());  d.setDate(d.getDate() - ((this.getDay() + 6) % 7) + 3); return d.getFullYear();}, //Fixed now
        Y: function() { return this.getFullYear(); },
        y: function() { return ('' + this.getFullYear()).substr(2); },
        // Time
        a: function() { return this.getHours() < 12 ? 'am' : 'pm'; },
        A: function() { return this.getHours() < 12 ? 'AM' : 'PM'; },
        B: function() { return Math.floor((((this.getUTCHours() + 1) % 24) + this.getUTCMinutes() / 60 + this.getUTCSeconds() / 3600) * 1000 / 24); }, // Fixed now
        g: function() { return this.getHours() % 12 || 12; },
        G: function() { return this.getHours(); },
        h: function() { return ((this.getHours() % 12 || 12) < 10 ? '0' : '') + (this.getHours() % 12 || 12); },
        H: function() { return (this.getHours() < 10 ? '0' : '') + this.getHours(); },
        i: function() { return (this.getMinutes() < 10 ? '0' : '') + this.getMinutes(); },
        s: function() { return (this.getSeconds() < 10 ? '0' : '') + this.getSeconds(); },
        u: function() { var m = this.getMilliseconds(); return (m < 10 ? '00' : (m < 100 ? '0' : '')) + m; },
        // Timezone
        e: function() { return "Not Yet Supported"; },
        I: function() {
            var DST = null;
                for (var i = 0; i < 12; ++i) {
                        var d = new Date(this.getFullYear(), i, 1);
                        var offset = d.getTimezoneOffset();

                        if (DST === null) DST = offset;
                        else if (offset < DST) { DST = offset; break; }
                        else if (offset > DST) break;
                }
                return (this.getTimezoneOffset() == DST) | 0;
            },
        O: function() { return (-this.getTimezoneOffset() < 0 ? '-' : '+') + (Math.abs(this.getTimezoneOffset() / 60) < 10 ? '0' : '') + (Math.abs(this.getTimezoneOffset() / 60)) + '00'; },
        P: function() { return (-this.getTimezoneOffset() < 0 ? '-' : '+') + (Math.abs(this.getTimezoneOffset() / 60) < 10 ? '0' : '') + (Math.abs(this.getTimezoneOffset() / 60)) + ':00'; }, // Fixed now
        T: function() { var m = this.getMonth(); this.setMonth(0); var result = this.toTimeString().replace(/^.+ \(?([^\)]+)\)?$/, '$1'); this.setMonth(m); return result;},
        Z: function() { return -this.getTimezoneOffset() * 60; },
        // Full Date/Time
        c: function() { return this.format("Y-m-d\\TH:i:sP"); }, // Fixed now
        r: function() { return this.toString(); },
        U: function() { return this.getTime() / 1000; }
    };


    var initLocaleFormats = function() {
        shortMonths = [
            _kiwi.global.i18n.translate('client.libs.date_format.short_months.january').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.short_months.february').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.short_months.march').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.short_months.april').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.short_months.may').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.short_months.june').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.short_months.july').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.short_months.august').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.short_months.september').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.short_months.october').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.short_months.november').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.short_months.december').fetch()
        ];
        longMonths = [
            _kiwi.global.i18n.translate('client.libs.date_format.long_months.january').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.long_months.february').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.long_months.march').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.long_months.april').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.long_months.may').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.long_months.june').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.long_months.july').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.long_months.august').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.long_months.september').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.long_months.october').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.long_months.november').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.long_months.december').fetch()
        ];
        shortDays = [
            _kiwi.global.i18n.translate('client.libs.date_format.short_days.monday').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.short_days.tuesday').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.short_days.wednesday').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.short_days.thursday').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.short_days.friday').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.short_days.saturday').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.short_days.sunday').fetch()
        ];
        longDays = [
            _kiwi.global.i18n.translate('client.libs.date_format.long_days.monday').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.long_days.tuesday').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.long_days.wednesday').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.long_days.thursday').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.long_days.friday').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.long_days.saturday').fetch(),
            _kiwi.global.i18n.translate('client.libs.date_format.long_days.sunday').fetch()
        ];

        locale_init = true;
    };
    /* End of date.format */


    // Finally.. the actuall formatDate function
    return function(working_date, format) {
        if (!locale_init)
            initLocaleFormats();

        working_date = working_date || new Date();
        format = format || _kiwi.global.i18n.translate('client_date_format').fetch();

        return format.replace(/(\\?)(.)/g, function(_, esc, chr) {
            return (esc === '' && replaceChars[chr]) ? replaceChars[chr].call(working_date) : chr;
        });
    };
})();


/*
 * The same functionality as EventEmitter but with the inclusion of callbacks
 */



function PluginInterface () {
    // Holder for all the bound listeners by this module
    this._listeners = {};

    // Event proxies
    this._parent = null;
    this._children = [];
}



PluginInterface.prototype.on = function (event_name, fn, scope) {
    this._listeners[event_name] = this._listeners[event_name] || [];
    this._listeners[event_name].push(['on', fn, scope]);
};



PluginInterface.prototype.once = function (event_name, fn, scope) {
    this._listeners[event_name] = this._listeners[event_name] || [];
    this._listeners[event_name].push(['once', fn, scope]);
};



PluginInterface.prototype.off = function (event_name, fn, scope) {
    var idx;

    if (typeof event_name === 'undefined') {
        // Remove all listeners
        this._listeners = {};

    } else if (typeof fn === 'undefined') {
        // Remove all of 1 event type
        delete this._listeners[event_name];

    } else if (typeof scope === 'undefined') {
        // Remove a single event type + callback
        for (idx in (this._listeners[event_name] || [])) {
            if (this._listeners[event_name][idx][1] === fn) {
                delete this._listeners[event_name][idx];
            }
        }
    } else {
        // Remove a single event type + callback + scope
        for (idx in (this._listeners[event_name] || [])) {
            if (this._listeners[event_name][idx][1] === fn && this._listeners[event_name][idx][2] === scope) {
                delete this._listeners[event_name][idx];
            }
        }
    }
};



PluginInterface.prototype.getListeners = function(event_name) {
    return this._listeners[event_name] || [];
};



PluginInterface.prototype.createProxy = function() {
    var proxy = new PluginInterface();
    proxy._parent = this._parent || this;
    proxy._parent._children.push(proxy);

    return proxy;
};



PluginInterface.prototype.dispose = function() {
    this.off();

    if (this._parent) {
        var idx = this._parent._children.indexOf(this);
        if (idx > -1) {
            this._parent._children.splice(idx, 1);
        }
    }
};



// Call all the listeners for a certain event, passing them some event data that may be changed
PluginInterface.prototype.emit = function (event_name, event_data) {
    var emitter = new this.EmitCall(event_name, event_data),
        listeners = [],
        child_idx;

    // Get each childs event listeners in order of last created
    for(child_idx=this._children.length-1; child_idx>=0; child_idx--) {
        listeners = listeners.concat(this._children[child_idx].getListeners(event_name));
    }

    // Now include any listeners directly on this instance
    listeners = listeners.concat(this.getListeners(event_name));

    // Once emitted, remove any 'once' bound listeners
    emitter.then(function () {
        var len = listeners.length,
            idx;

        for(idx = 0; idx < len; idx++) {
            if (listeners[idx][0] === 'once') {
                listeners[idx] = undefined;
            }
        }
    });

    // Emit the event to the listeners and return
    emitter.callListeners(listeners);
    return emitter;
};



// Promise style object to emit events to listeners
PluginInterface.prototype.EmitCall = function EmitCall (event_name, event_data) {
    var that = this,
        completed = false,
        completed_fn = [],

        // Has event.preventDefault() been called
        prevented = false,
        prevented_fn = [];


    // Emit this event to an array of listeners
    function callListeners(listeners) {
        var current_event_idx = -1;

        // Make sure we have some data to pass to the listeners
        event_data = event_data || undefined;

        // If no bound listeners for this event, leave now
        if (listeners.length === 0) {
            emitComplete();
            return;
        }


        // Call the next listener in our array
        function nextListener() {
            var listener, event_obj;

            // We want the next listener
            current_event_idx++;

            // If we've ran out of listeners end this emit call
            if (!listeners[current_event_idx]) {
                emitComplete();
                return;
            }

            // Object the listener ammends to tell us what it's going to do
            event_obj = {
                // If changed to true, expect this listener is going to callback
                wait: false,

                // If wait is true, this callback must be called to continue running listeners
                callback: function () {
                    // Invalidate this callback incase a listener decides to call it again
                    event_obj.callback = undefined;

                    nextListener.apply(that);
                },

                // Prevents the default 'done' functions from executing
                preventDefault: function () {
                    prevented = true;
                }
            };


            listener = listeners[current_event_idx];
            listener[1].call(listener[2] || that, event_obj, event_data);

            // If the listener hasn't signalled it's going to wait, proceed to next listener
            if (!event_obj.wait) {
                // Invalidate the callback just incase a listener decides to call it anyway
                event_obj.callback = undefined;

                nextListener();
            }
        }

        nextListener();
    }



    function emitComplete() {
        completed = true;

        var funcs = prevented ? prevented_fn : completed_fn;
        funcs = funcs || [];

        // Call the completed/prevented functions
        for (var idx = 0; idx < funcs.length; idx++) {
            if (typeof funcs[idx] === 'function') funcs[idx]();
        }
    }



    function addCompletedFunc(fn) {
        // Only accept functions
        if (typeof fn !== 'function') return false;

        completed_fn.push(fn);

        // If we have already completed the emits, call this now
        if (completed && !prevented) fn();

        return this;
    }



    function addPreventedFunc(fn) {
        // Only accept functions
        if (typeof fn !== 'function') return false;

        prevented_fn.push(fn);

        // If we have already completed the emits, call this now
        if (completed && prevented) fn();

        return this;
    }


    return {
        callListeners: callListeners,
        then: addCompletedFunc,
        catch: addPreventedFunc
    };
};



// If running a node module, set the exports
if (typeof module === 'object' && typeof module.exports !== 'undefined') {
    module.exports = PluginInterface;
}



/*
 * Example usage
 */


/*
var modules = new PluginInterface();



// A plugin
modules.on('irc message', function (event, data) {
    //event.wait = true;
    setTimeout(event.callback, 2000);
});




// Core code that is being extended by plugins
var data = {
    nick: 'prawnsalald',
    command: '/dothis'
};

modules.emit('irc message', data).done(function () {
    console.log('Your command is: ' + data.command);
});
*/


/*jslint devel: true, browser: true, continue: true, sloppy: true, forin: true, plusplus: true, maxerr: 50, indent: 4, nomen: true, regexp: true*/
/*globals $, front, gateway, Utilityview */



/**
*   Generate a random string of given length
*   @param      {Number}    string_length   The length of the random string
*   @returns    {String}                    The random string
*/
function randomString(string_length) {
    var chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXTZabcdefghiklmnopqrstuvwxyz",
        randomstring = '',
        i,
        rnum;
    for (i = 0; i < string_length; i++) {
        rnum = Math.floor(Math.random() * chars.length);
        randomstring += chars.substring(rnum, rnum + 1);
    }
    return randomstring;
}

/**
*   String.trim shim
*/
if (typeof String.prototype.trim === 'undefined') {
    String.prototype.trim = function () {
        return this.replace(/^\s+|\s+$/g, "");
    };
}

/**
*   String.lpad shim
*   @param      {Number}    length      The length of padding
*   @param      {String}    characher   The character to pad with
*   @returns    {String}                The padded string
*/
if (typeof String.prototype.lpad === 'undefined') {
    String.prototype.lpad = function (length, character) {
        var padding = "",
            i;
        for (i = 0; i < length; i++) {
            padding += character;
        }
        return (padding + this).slice(-length);
    };
}


/**
*   Convert seconds into hours:minutes:seconds
*   @param      {Number}    secs    The number of seconds to converts
*   @returns    {Object}            An object representing the hours/minutes/second conversion of secs
*/
function secondsToTime(secs) {
    var hours, minutes, seconds, divisor_for_minutes, divisor_for_seconds, obj;
    hours = Math.floor(secs / (60 * 60));

    divisor_for_minutes = secs % (60 * 60);
    minutes = Math.floor(divisor_for_minutes / 60);

    divisor_for_seconds = divisor_for_minutes % 60;
    seconds = Math.ceil(divisor_for_seconds);

    obj = {
        "h": hours,
        "m": minutes,
        "s": seconds
    };
    return obj;
}


/* Command input Alias + re-writing */
function InputPreProcessor () {
    this.recursive_depth = 3;

    this.aliases = {};
    this.vars = {version: 1};

    // Current recursive depth
    var depth = 0;


    // Takes an array of words to process!
    this.processInput = function (input) {
        var words = input || [],
            alias = this.aliases[words[0]],
            alias_len,
            current_alias_word = '',
            compiled = [];

        // If an alias wasn't found, return the original input
        if (!alias) return input;

        // Split the alias up into useable words
        alias = alias.split(' ');
        alias_len = alias.length;

        // Iterate over each word and pop them into the final compiled array.
        // Any $ words are processed with the result ending into the compiled array.
        for (var i=0; i<alias_len; i++) {
            current_alias_word = alias[i];

            // Non $ word
            if (current_alias_word[0] !== '$') {
                compiled.push(current_alias_word);
                continue;
            }

            // Refering to an input word ($N)
            if (!isNaN(current_alias_word[1])) {
                var num = current_alias_word.match(/\$(\d+)(\+)?(\d+)?/);

                // Did we find anything or does the word it refers to non-existant?
                if (!num || !words[num[1]]) continue;

                if (num[2] === '+' && num[3]) {
                    // Add X number of words
                    compiled = compiled.concat(words.slice(parseInt(num[1], 10), parseInt(num[1], 10) + parseInt(num[3], 10)));
                } else if (num[2] === '+') {
                    // Add the remaining of the words
                    compiled = compiled.concat(words.slice(parseInt(num[1], 10)));
                } else {
                    // Add a single word
                    compiled.push(words[parseInt(num[1], 10)]);
                }

                continue;
            }


            // Refering to a variable
            if (typeof this.vars[current_alias_word.substr(1)] !== 'undefined') {

                // Get the variable
                compiled.push(this.vars[current_alias_word.substr(1)]);

                continue;
            }

        }

        return compiled;
    };


    this.process = function (input) {
        input = input || '';

        var words = input.split(' ');

        depth++;
        if (depth >= this.recursive_depth) {
            depth--;
            return input;
        }

        if (this.aliases[words[0]]) {
            words = this.processInput(words);

            if (this.aliases[words[0]]) {
                words = this.process(words.join(' ')).split(' ');
            }

        }

        depth--;
        return words.join(' ');
    };
}


/**
 * Convert HSL to RGB formatted colour
 */
function hsl2rgb(h, s, l) {
    var m1, m2, hue;
    var r, g, b
    s /=100;
    l /= 100;
    if (s == 0)
        r = g = b = (l * 255);
    else {
        function HueToRgb(m1, m2, hue) {
            var v;
            if (hue < 0)
                hue += 1;
            else if (hue > 1)
                hue -= 1;

            if (6 * hue < 1)
                v = m1 + (m2 - m1) * hue * 6;
            else if (2 * hue < 1)
                v = m2;
            else if (3 * hue < 2)
                v = m1 + (m2 - m1) * (2/3 - hue) * 6;
            else
                v = m1;

            return 255 * v;
        }
        if (l <= 0.5)
            m2 = l * (s + 1);
        else
            m2 = l + s - l * s;
        m1 = l * 2 - m2;
        hue = h / 360;
        r = HueToRgb(m1, m2, hue + 1/3);
        g = HueToRgb(m1, m2, hue);
        b = HueToRgb(m1, m2, hue - 1/3);
    }
    return [r,g,b];
}


/**
 * Formats a kiwi message to IRC format
 */
function formatToIrcMsg(message) {
    // Format any colour codes (eg. $c4)
    message = message.replace(/%C(\d)/g, function(match, colour_number) {
        return String.fromCharCode(3) + colour_number.toString();
    });

    var formatters = {
        B: '\x02',    // Bold
        I: '\x1D',    // Italics
        U: '\x1F',    // Underline
        O: '\x0F'     // Out / Clear formatting
    };
    message = message.replace(/%([BIUO])/g, function(match, format_code) {
        if (typeof formatters[format_code.toUpperCase()] !== 'undefined')
            return formatters[format_code.toUpperCase()];
    });

    return message;
}


/**
*   Formats a message. Adds bold, underline and colouring
*   @param      {String}    msg The message to format
*   @returns    {String}        The HTML formatted message
*/
function formatIRCMsg (msg) {
    "use strict";
    var out = '',
        currentTag = '',
        openTags = {
            bold: false,
            italic: false,
            underline: false,
            colour: false
        },
        spanFromOpen = function () {
            var style = '',
                colours;
            if (!(openTags.bold || openTags.italic || openTags.underline || openTags.colour)) {
                return '';
            } else {
                style += (openTags.bold) ? 'font-weight: bold; ' : '';
                style += (openTags.italic) ? 'font-style: italic; ' : '';
                style += (openTags.underline) ? 'text-decoration: underline; ' : '';
                if (openTags.colour) {
                    colours = openTags.colour.split(',');
                    style += 'color: ' + colours[0] + ((colours[1]) ? '; background-color: ' + colours[1] + ';' : '');
                }
                return '<span class="format_span" style="' + style + '">';
            }
        },
        colourMatch = function (str) {
            var re = /^\x03(([0-9][0-9]?)(,([0-9][0-9]?))?)/;
            return re.exec(str);
        },
        hexFromNum = function (num) {
            switch (parseInt(num, 10)) {
            case 0:
                return '#FFFFFF';
            case 1:
                return '#000000';
            case 2:
                return '#000080';
            case 3:
                return '#008000';
            case 4:
                return '#FF0000';
            case 5:
                return '#800040';
            case 6:
                return '#800080';
            case 7:
                return '#FF8040';
            case 8:
                return '#FFFF00';
            case 9:
                return '#80FF00';
            case 10:
                return '#008080';
            case 11:
                return '#00FFFF';
            case 12:
                return '#0000FF';
            case 13:
                return '#FF55FF';
            case 14:
                return '#808080';
            case 15:
                return '#C0C0C0';
            default:
                return null;
            }
        },
        i = 0,
        colours = [],
        match;

    for (i = 0; i < msg.length; i++) {
        switch (msg[i]) {
        case '\x02':
            if ((openTags.bold || openTags.italic || openTags.underline || openTags.colour)) {
                out += currentTag + '</span>';
            }
            openTags.bold = !openTags.bold;
            currentTag = spanFromOpen();
            break;
        case '\x1D':
            if ((openTags.bold || openTags.italic || openTags.underline || openTags.colour)) {
                out += currentTag + '</span>';
            }
            openTags.italic = !openTags.italic;
            currentTag = spanFromOpen();
            break;
        case '\x1F':
            if ((openTags.bold || openTags.italic || openTags.underline || openTags.colour)) {
                out += currentTag + '</span>';
            }
            openTags.underline = !openTags.underline;
            currentTag = spanFromOpen();
            break;
        case '\x03':
            if ((openTags.bold || openTags.italic || openTags.underline || openTags.colour)) {
                out += currentTag + '</span>';
            }
            match = colourMatch(msg.substr(i, 6));
            if (match) {
                i += match[1].length;
                // 2 & 4
                colours[0] = hexFromNum(match[2]);
                if (match[4]) {
                    colours[1] = hexFromNum(match[4]);
                }
                openTags.colour = colours.join(',');
            } else {
                openTags.colour = false;
            }
            currentTag = spanFromOpen();
            break;
        case '\x0F':
            if ((openTags.bold || openTags.italic || openTags.underline || openTags.colour)) {
                out += currentTag + '</span>';
            }
            openTags.bold = openTags.italic = openTags.underline = openTags.colour = false;
            break;
        default:
            if ((openTags.bold || openTags.italic || openTags.underline || openTags.colour)) {
                currentTag += msg[i];
            } else {
                out += msg[i];
            }
            break;
        }
    }
    if ((openTags.bold || openTags.italic || openTags.underline || openTags.colour)) {
        out += currentTag + '</span>';
    }
    return out;
}

function escapeRegex (str) {
    return str.replace(/[\[\\\^\$\.\|\?\*\+\(\)]/g, '\\$&');
}

function emoticonFromText(str) {
    var words_in = str.split(' '),
        words_out = [],
        i,
        pushEmoticon = function (alt, emote_name) {
            words_out.push('<i class="emoticon ' + emote_name + '">' + alt + '</i>');
        };

    for (i = 0; i < words_in.length; i++) {
        switch(words_in[i]) {
        case ':)':
            pushEmoticon(':)', 'smile');
            break;
        case ':(':
            pushEmoticon(':(', 'sad');
            break;
        case ':3':
            pushEmoticon(':3', 'lion');
            break;
        case ';3':
            pushEmoticon(';3', 'winky_lion');
            break;
        case ':s':
        case ':S':
            pushEmoticon(':s', 'confused');
            break;
        case ';(':
        case ';_;':
            pushEmoticon(';(', 'cry');
            break;
        case ';)':
            pushEmoticon(';)', 'wink');
            break;
        case ';D':
            pushEmoticon(';D', 'wink_happy');
            break;
        case ':P':
        case ':p':
            pushEmoticon(':P', 'tongue');
            break;
        case 'xP':
            pushEmoticon('xP', 'cringe_tongue');
            break;
        case ':o':
        case ':O':
        case ':0':
            pushEmoticon(':o', 'shocked');
            break;
        case ':D':
            pushEmoticon(':D', 'happy');
            break;
        case '^^':
        case '^.^':
            pushEmoticon('^^,', 'eyebrows');
            break;
        case '&lt;3':
            pushEmoticon('<3', 'heart');
            break;
        case '&gt;_&lt;':
        case '&gt;.&lt;':
            pushEmoticon('>_<', 'doh');
            break;
        case 'XD':
        case 'xD':
            pushEmoticon('xD', 'big_grin');
            break;
        case 'o.0':
        case 'o.O':
            pushEmoticon('o.0', 'wide_eye_right');
            break;
        case '0.o':
        case 'O.o':
            pushEmoticon('0.o', 'wide_eye_left');
            break;
        case ':\\':
        case '=\\':
        case ':/':
        case '=/':
            pushEmoticon(':\\', 'unsure');
            break;
        default:
            words_out.push(words_in[i]);
        }
    }

    return words_out.join(' ');
}

// Code based on http://anentropic.wordpress.com/2009/06/25/javascript-iso8601-parser-and-pretty-dates/#comment-154
function parseISO8601(str) {
    if (Date.prototype.toISOString) {
        return new Date(str);
    } else {
        var parts = str.split('T'),
            dateParts = parts[0].split('-'),
            timeParts = parts[1].split('Z'),
            timeSubParts = timeParts[0].split(':'),
            timeSecParts = timeSubParts[2].split('.'),
            timeHours = Number(timeSubParts[0]),
            _date = new Date();

        _date.setUTCFullYear(Number(dateParts[0]));
        _date.setUTCDate(1);
        _date.setUTCMonth(Number(dateParts[1])-1);
        _date.setUTCDate(Number(dateParts[2]));
        _date.setUTCHours(Number(timeHours));
        _date.setUTCMinutes(Number(timeSubParts[1]));
        _date.setUTCSeconds(Number(timeSecParts[0]));
        if (timeSecParts[1]) {
            _date.setUTCMilliseconds(Number(timeSecParts[1]));
        }

        return _date;
    }
}

// Simplyfy the translation syntax
function translateText(string_id, params) {
    params = params || '';

    return _kiwi.global.i18n.translate(string_id).fetch(params);
}

/**
 * Simplyfy the text styling syntax
 *
 * Syntax:
 *   %nick:     nickname
 *   %channel:  channel
 *   %ident:    ident
 *   %host:     host
 *   %realname: realname
 *   %text:     translated text
 *   %C[digit]: color
 *   %B:        bold
 *   %I:        italic
 *   %U:        underline
 *   %O:        cancel styles
 **/
function styleText(string_id, params) {
    var style, text;

    //style = formatToIrcMsg(_kiwi.app.text_theme[string_id]);
    style = _kiwi.app.text_theme[string_id];
    style = formatToIrcMsg(style);

    // Expand a member mask into its individual parts (nick, ident, hostname)
    if (params.member) {
        params.nick = params.member.nick || '';
        params.ident = params.member.ident || '';
        params.host = params.member.hostname || '';
        params.prefix = params.member.prefix || '';
    }

    // Do the magic. Use the %shorthand syntax to produce output.
    text = style.replace(/%([A-Z]{2,})/ig, function(match, key) {
        if (typeof params[key] !== 'undefined')
            return params[key];
    });

    return text;
}




})(window);