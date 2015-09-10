var conf = {};

// Run the Kiwi server under a different user/group
conf.user = "root";
conf.group = "root";

// Log file location
conf.log = "kiwi.log";

/*
 * Server listen blocks
 */

// Do not edit this line!
conf.servers = [];

// Example server block
conf.servers.push({
    port:   7000,
    address: "127.0.0.1"
});

// Example SSL server block
//conf.servers.push({
//    port:     7000,
//    address: "0.0.0.0",
//    ssl:   true,
//    ssl_key: "server.key",
//    ssl_cert: "cert.pem"
//});

// Network interface for outgoing connections
conf.outgoing_address = {
    IPv4: '0.0.0.0'
    //IPv6: '::'
};


// Do we want to enable the built in Identd server?
//conf.identd = {
//    enabled: false,
//   port: 113,
//    address: "0.0.0.0"
//};


// Where the client files are
conf.public_http = "client/";

// Transports available to the client.
// Behind an Apache reverse proxy? Uncomment the below - Apache does not support websockets!
//conf.client_transports = ['polling'];

// Max connections per connection. 0 to disable
conf.max_client_conns = 5;

// Max connections per server. 0 to disable.
// Setting is ignored if:
//   - There is a WEBIRC password configured for the server,
//   - Kiwi is configured to send the client's ip as a username for the server, or
//   - Kiwi is running in restricted server mode.
conf.max_server_conns = 0;

/*
* Default encoding to be used by the server
* As specified and limited to iconv-lite library support.
*/
conf.default_encoding = 'utf8';


/*
* Default GECOS (real name) for IRC connections
* %n will be replaced with the users nick
* %h will be replaced with the users hostname
*/
//conf.default_gecos = 'Web IRC Client';


/*
* Auto reconnect if the IRC server disconnects a kiwi user
* Hundreds of connected users getting disconnected then reconnecting at once may see
* high CPU usage causing further dropouts. Set to false if under high usage.
*/
conf.ircd_reconnect = true;

/*
 * Client side plugins
 * Array of URLs that will be loaded into the browser when the client first loads up
 * See http://github.com/prawnsalad/KiwiIRC/wiki/Client-plugins
 */
conf.client_plugins = [
    'kiwi/assets/plugins/emoticonlist.html',
    'kiwi/assets/plugins/textstyle.html',
];

// Directory to find the server modules
conf.module_dir = "../server_modules/";

// Which modules to load
conf.modules = [];


// WebIRC password enabled for this server
//conf.webirc_pass = "foobar";

// Multiple WebIRC passwords may be used for multiple servers
//conf.webirc_pass = {
//    "irc.network.com":  "configured_webirc_password",
//    "127.0.0.1":        "foobar"
//};

// Some IRCDs require the clients IP via the username/ident
conf.ip_as_username = [
    //"irc.network.com",
    //"127.0.0.1"
];

// Whether to verify IRC servers' SSL certificates against built-in well-known certificate authorities
conf.reject_unauthorised_certificates = false;

/*
 * Reverse proxy settings
 * Reverse proxies that have been reported to work can be found at:
 *     https://kiwiirc.com/docs/installing/proxies
 */

// Whitelisted HTTP proxies in CIDR format
conf.http_proxies = ["127.0.0.1/32"];

// Header that contains the real-ip from the HTTP proxy
conf.http_proxy_ip_header = "x-forwarded-for";

// Base HTTP path to the KIWI IRC client (eg. /kiwi)
conf.http_base_path = "/kiwi";


/*
 * SOCKS (version 5) proxy settings
 * This feature is only available on node 0.10.0 and above.
 * Do not enable it if you're running 0.8 or below or Bad Things will happen.
 */
conf.socks_proxy = {};

// Enable proxying outbound connections through a SOCKS proxy
conf.socks_proxy.enabled = false;

// Proxy *all* outbound connections through a SOCKS proxy
conf.socks_proxy.all = false;

// Use SOCKS proxy for these hosts only (if conf.sock_proxy.all === false)
conf.socks_proxy.proxy_hosts = [
    "irc.example.com"
];

// Host and port for the SOCKS proxy
conf.socks_proxy.address = '127.0.0.1';
conf.socks_proxy.port = 1080;

// Username and password for the SOCKS proxy
// Set user to null to disable password authentication
conf.socks_proxy.user = null;
conf.socks_proxy.pass = null;



// Default quit message
conf.quit_message = "http://irc.perfi.wang/ - A Web IRC client";


// Default settings for the client. These may be changed in the browser
conf.client = {
    server: 'irc.perfi.wang',
    port:    6667,
    ssl:     false,
    channel: ['#灌水区','#PERL学习交流','#Mojolicious','#shell/perl/python'],
    channel_key: '',
    nick:    '王大锤_?',
    settings: {
        theme: 'basic',
        text_theme: 'default',
        channel_list_style: 'tabs',
        scrollback: 250,
        show_joins_parts: true,
        show_timestamps: true,
        use_24_hour_timestamps: true,
        mute_sounds: false,
        show_emoticons: true,
        count_all_activity: false,
        locale: null  // null = use the browser locale settings
    },
    window_title: "Web IRC"
};

// List of themes available for the user to choose from
conf.client_themes = [
    'relaxed',
    'mini',
    'cli',
    'basic'
];


// If set, the client may only connect to this 1 IRC server
conf.restrict_server = "irc.perfi.wang";
conf.restrict_server_port = 6667;
conf.restrict_server_ssl = false;
//conf.restrict_server_channel = "#kiwiirc";
conf.restrict_server_channel_key = "";
conf.restrict_server_password = "";
//conf.restrict_server_nick = "irc_";

/*
 * Do not amend the below lines unless you understand the changes!
 */
module.exports.production = conf;
