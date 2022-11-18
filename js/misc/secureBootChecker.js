// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/*
 * Copyright 2022 Red Hat, Inc
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, see <http://www.gnu.org/licenses/>.
 */

const Gio = imports.gi.Gio;

const { GLib, St, Shell } = imports.gi;

const { loadInterfaceXML } = imports.misc.fileUtils;

const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;

const FwupdIface = loadInterfaceXML('org.freedesktop.fwupd');
const FwupdProxy = Gio.DBusProxy.makeProxyWrapper(FwupdIface);

var SecureBootState = {
    ACTIVE: 1,
    REDUCED: 2,
    INACTIVE: 3,
    CHECK_DISABLED: 4,
};

// eslint-disable-next-line
var secureBootChecker = class {
    constructor() {
        this._sbFlag = null;
        this._pkFLag = null;
        this._isFwupdPresent = true;
    }

    setSecureBootFlags(attrsObj) {
        if (attrsObj['AppstreamId'] === 'org.fwupd.hsi.Uefi.SecureBoot')
            this._sbFlag = attrsObj['Flags'];
        else if (attrsObj['AppstreamId'] === 'org.fwupd.hsi.Uefi.Pk')
            this._pkFlag = attrsObj['Flags'];
    }

    async fwupdRemoteSecurityAttrAsync() {
        let res = null;
        try {
            let _fwupdProxy = await new FwupdProxy(
                Gio.DBus.system,
                'org.freedesktop.fwupd',
                '/'
            );
            res = await _fwupdProxy.GetHostSecurityAttrsAsync();
            let attrVar =  new GLib.Variant('aa{sv}', res[0]);
            let attrDictFull = attrVar.recursiveUnpack();

            for (var index in attrDictFull) {
                let keys = Object.keys(attrDictFull[index]);
                console.log(keys);
                if (keys.indexOf('AppstreamId') !== -1)
                    this.setSecureBootFlags(attrDictFull[index]);
            }
        } catch (error) {
            this._isFwupdPresent = false;
            return;
        }

        this._isFwupdPresent = true;
    }

    setNotification(notificationStr, body) {
        let notifySource = new MessageTray.SystemNotificationSource();
        notifySource.connect('destroy', () => {
            notifySource = null;
        });
        Main.messageTray.add(notifySource);

        let secureBootWarningIcon = new St.Icon({icon_name: 'application-x-firmware-symbolic'});
        let notification = null;
        if (notifySource.notifications.length === 0) {
            notification = new MessageTray.Notification(notifySource, notificationStr, body, {gicon: secureBootWarningIcon.get_gicon()});
            notification.setUrgency(MessageTray.Urgency.CRITICAL);
            notification.setTransient(true);

            if (Main.sessionMode.hasWindows) {
                const appSystem = Shell.AppSystem.get_default();
                let _settingsAppInfo = appSystem.lookup_app('gnome-firmware-security-panel.desktop');
                if (_settingsAppInfo) {
                    notification.addAction(_('Details'), () => {
                        _settingsAppInfo.launch(0, -1, Shell.AppLaunchGpu.APP_PREF);
                    });
                }
            }
        }
        notifySource.showNotification(notification);
    }

    _isGlobalEnabled() {
        const file = Gio.File.new_for_path('/proc/cmdline');
        const [, contents, unusedetag] = file.load_contents(null);
        const decoder = new TextDecoder();
        const contentsString = decoder.decode(contents);
        if (contentsString.includes('sb-check=false'))
            return false;
        return true;
    }

    async getSecureBootState() {
        if (!this._isGlobalEnabled()) {
            this.isFwupdPresent = false;
            return SecureBootState.CHECK_DISABLED;
        }

        await this.fwupdRemoteSecurityAttrAsync();
        if (this._isFwupdPresent === false)
            return SecureBootState.CHECK_DISABLED;

        if ((this._sbFlag & 0x2) > 0)
            return SecureBootState.INACTIVE;
        else if ((this._pkFLag & 0x1) > 0 && (this._sbFlag & 0x1) > 0)
            return SecureBootState.ACTIVE;
        else if ((this._sbFlag & 0x1) > 0)
            return SecureBootState.REDUCED;
        else
            return SecureBootState.INACTIVE;
    }

    setSecureBootNotification(sbStatus) {
        let sbEnabled = true;

        try {
            let settings = new Gio.Settings({schema_id: 'org.gnome.shell.check-secure-boot'});
            sbEnabled = settings.get_boolean('secure-boot-notification');
        } catch {
            sbEnabled = true;
        }
        if (!sbEnabled) {
            this.isFwupdPresent = false;
            return;
        }

        if (sbStatus !== SecureBootState.CHECK_DISABLED &&
            sbStatus !== SecureBootState.ACTIVE) {
            this.setNotification(_('Reduced Device Security'),
                _('Security protections have been removed since last start. This could be a result of malware.'));
        }
    }
};
