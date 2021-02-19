// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported CredentialsManager */

const Credential = imports.gdm.credentialManager;

var SERVICE_NAME = 'gdm-ovirtcred';

const credentialsIface = 'org.ovirt.vdsm.Credentials';
const credentialsPath = '/org/ovirt/vdsm/Credentials';

var CredentialsManager = class extends Credential.DBusCredentialManager {
    constructor() {
        super(SERVICE_NAME, credentialsIface, credentialsIface, credentialsPath);
    }
};
