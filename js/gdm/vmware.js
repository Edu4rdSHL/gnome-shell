// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported getVmwareCredentialsManager */

const Credential = imports.gdm.credentialManager;

var SERVICE_NAME = 'gdm-vmwcred';

const credentialsPath = '/org/vmware/viewagent/Credentials';
const credentialsIface = 'org.vmware.viewagent.Credentials';

let _vmwareCredentialsManager = null;

var VmwareCredentialsManager = class VmwareCredentialsManager extends Credential.DBusCredentialManager {
    constructor() {
        super(SERVICE_NAME, credentialsIface, credentialsIface, credentialsPath);
    }
};

function getVmwareCredentialsManager() {
    if (!_vmwareCredentialsManager)
        _vmwareCredentialsManager = new VmwareCredentialsManager();

    return _vmwareCredentialsManager;
}
