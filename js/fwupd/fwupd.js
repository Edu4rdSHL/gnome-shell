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

// eslint-disable-next-line
var Fwupd = class {
    constructor() {
        this._source = null;
        this.sbFlag = null;
        this.pkFLag = null;
        this.isFwupdPresent = false;

        if (this._source === null) {
            this._source = new MessageTray.SystemNotificationSource();
            this._source.connect('destroy', () => {
                this._source = null;
            });
            Main.messageTray.add(this._source);
        }

        this._fwupdproxy = new FwupdProxy(
            Gio.DBus.system,
            'org.freedesktop.fwupd',
            '/'
        );
    }

    setSecureBootFlags(attrsObj) {
        if (attrsObj['AppstreamId'] === 'org.fwupd.hsi.Uefi.SecureBoot')
            this.sbFlag = attrsObj['Flags'];
        else if (attrsObj['AppstreamId'] === 'org.fwupd.hsi.Uefi.Pk')
            this.pkFLag = attrsObj['Flags'];
    }

    fwupdRemoteSecurityAttrAsync() {
        return new Promise((resolve, reject) => {
            this._fwupdproxy.GetHostSecurityAttrsRemote(new Gio.Cancellable(), (returnValue, errorObj, unusedfdList) => {
                if (errorObj === null) {
                    let attrVar =  new GLib.Variant('aa{sv}', returnValue[0]);
                    let attrDictFull = attrVar.recursiveUnpack();

                    for (var index in attrDictFull) {
                        let keys = Object.keys(attrDictFull[index]);
                        if (keys.indexOf('AppstreamId') !== -1)
                            this.setSecureBootFlags(attrDictFull[index]);
                    }
                    resolve(returnValue);
                } else {
                    reject(errorObj);
                }
            });
        });
    }

    setNotification(notificationStr, body, sessionMode) {
        let secureBootWarningIcon = new St.Icon({ icon_name: 'application-x-firmware-symbolic' });
        let notification = null;
        if (this._source.notifications.length === 0) {
            notification = new MessageTray.Notification(this._source, notificationStr, body, { gicon: secureBootWarningIcon.get_gicon() });
            notification.setUrgency(3);
            notification.setTransient(true);

            if (sessionMode === 'user') {
                const appSystem = Shell.AppSystem.get_default();
                let _settingsAppInfo = appSystem.lookup_app('gnome-firmware-security-panel.desktop');
                if (_settingsAppInfo) {
                    notification.addAction(_('Details'), () => {
                        _settingsAppInfo.launch(0, -1, Shell.AppLaunchGpu.APP_PREF);
                    });
                }
            }
        }
        this._source.showNotification(notification);
    }

    _is_global_enabled() {
        const file = Gio.File.new_for_path('/proc/cmdline');
        const [, contents, unusedetag] = file.load_contents(null);
        const decoder = new TextDecoder('utf-8');
        const contentsString = decoder.decode(contents);
        if (contentsString.indexOf('sb-check=false') !== -1)
            return false;
        return true;
    }

    async securebootCheckAndNotify(sessionMode) {
        let sbEnabled = true;

        if (!this._is_global_enabled()) {
            this.isFwupdPresent = false;
            return;
        }

        try {
            let settings = new Gio.Settings({ schema_id: 'org.gnome.shell.sb-check' });
            sbEnabled = settings.get_boolean('notification-present');
        } catch {
            sbEnabled = true;
        }
        if (!sbEnabled) {
            this.isFwupdPresent = false;
            return;
        }

        try {
            await this.fwupdRemoteSecurityAttrAsync();
            this.isFwupdPresent = true;
        } catch {
            this.isFwupdPresent = false;
            return;
        }
        if ((this._sbFlag & 0x1) > 0) {
            this.setNotification(_('Reduced Device Security'),
                _('Security protections have been removed since last start. This could be a result of malware.'),
                sessionMode);
        } else {
            this.setNotification(_('Reduced Device Security'),
                _('Security protections have been removed since last start. This could be a result of malware.'),
                sessionMode);
        }
    }
};
