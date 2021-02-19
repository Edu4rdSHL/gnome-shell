// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported CredentialManager, DBusCredentialManager */

const { Gio } = imports.gi;
const Signals = imports.signals;

var CredentialManager = class CredentialManager {
    constructor(service) {
        this._token = null;
        this._service = service;
        this._authenticatedSignalId = null;
    }

    destroy() {
        this.disconnectAll();
    }

    get token() {
        return this._token;
    }

    set token(t) {
        this._token = t;
        if (this._token)
            this.emit('user-authenticated', this._token);
    }

    get service() {
        return this._service;
    }
};
Signals.addSignalMethods(CredentialManager.prototype);


var DBusCredentialManager = class extends CredentialManager {
    constructor(service, dbusName, dbusIface, dbusPath) {
        super(service);

        Gio.DBus.system.signal_subscribe(dbusName,
            dbusIface, 'UserAuthenticated', dbusPath, null,
            Gio.DBusSignalFlags.NONE, (_c, _sender, _path, _iface, _signal, params) => {
                const [token] = params.deep_unpack();
                this._onUserAuthenticated(token);
            });
    }

    _onUserAuthenticated(token) {
        this.token = token;
    }
};
