// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported getVmwareCredentialsManager */

const { Gio } = imports.gi;
const Credential = imports.gdm.credentialManager;

var SERVICE_NAME = 'gdm-vmwcred';

const credentialsPath = '/org/vmware/viewagent/Credentials';
const credentialsIface = 'org.vmware.viewagent.Credentials';

let _vmwareCredentialsManager = null;

var VmwareCredentialsManager = class VmwareCredentialsManager extends Credential.CredentialManager {
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

function getVmwareCredentialsManager() {
    if (!_vmwareCredentialsManager)
        _vmwareCredentialsManager = new VmwareCredentialsManager();

    return _vmwareCredentialsManager;
}
