// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported getOVirtCredentialsManager */

const Gio = imports.gi.Gio;
const Credential = imports.gdm.credentialManager;

var SERVICE_NAME = 'gdm-ovirtcred';

const credentialsIface = 'org.ovirt.vdsm.Credentials';
const credentialsPath = '/org/ovirt/vdsm/Credentials';

let _oVirtCredentialsManager = null;

var OVirtCredentialsManager = class OVirtCredentialsManager extends Credential.CredentialManager {
    constructor() {
        super(SERVICE_NAME);

        Gio.DBus.system.signal_subscribe(credentialsIface, credentialsIface,
            'UserAuthenticated', credentialsPath, null,
            Gio.DBusSignalFlags.NONE, (_c, _sender, _path, _iface, _signal, params) => {
                const [token] = params.deep_unpack();
                this.token = token;
            });
    }
};

function getOVirtCredentialsManager() {
    if (!_oVirtCredentialsManager)
        _oVirtCredentialsManager = new OVirtCredentialsManager();

    return _oVirtCredentialsManager;
}
