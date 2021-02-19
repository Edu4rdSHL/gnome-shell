// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported getOVirtCredentialsManager */

const Credential = imports.gdm.credentialManager;

var SERVICE_NAME = 'gdm-ovirtcred';

const credentialsIface = 'org.ovirt.vdsm.Credentials';
const credentialsPath = '/org/ovirt/vdsm/Credentials';

let _oVirtCredentialsManager = null;

var OVirtCredentialsManager = class OVirtCredentialsManager extends Credential.DBusCredentialManager {
    constructor() {
        super(SERVICE_NAME, credentialsIface, credentialsIface, credentialsPath);
    }
};

function getOVirtCredentialsManager() {
    if (!_oVirtCredentialsManager)
        _oVirtCredentialsManager = new OVirtCredentialsManager();

    return _oVirtCredentialsManager;
}
