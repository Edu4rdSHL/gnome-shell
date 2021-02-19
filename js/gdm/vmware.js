// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported CredentialsManager */

const Credential = imports.gdm.credentialManager;

var SERVICE_NAME = 'gdm-vmwcred';

const credentialsPath = '/org/vmware/viewagent/Credentials';
const credentialsIface = 'org.vmware.viewagent.Credentials';

var CredentialsManager = class extends Credential.DBusCredentialManager {
    constructor() {
        super(SERVICE_NAME, credentialsIface, credentialsIface, credentialsPath);
    }
};
