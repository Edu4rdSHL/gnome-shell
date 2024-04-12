import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as CheckBox from './checkBox.js';
import * as Dialog from './dialog.js';
import * as ModalDialog from './modalDialog.js';

import {loadInterfaceXML} from '../misc/fileUtils.js';

const RequestIface = loadInterfaceXML('org.freedesktop.impl.portal.Request');
const AccessIface = loadInterfaceXML('org.freedesktop.impl.portal.Access');

const MONITOR_FOCUS_APP_TIMEOUT_MS = 2000;

/** @enum {number} */
const DialogResponse = {
    OK: 0,
    CANCEL: 1,
    CLOSED: 2,
};

const AccessDialog = GObject.registerClass(
class AccessDialog extends ModalDialog.ModalDialog {
    _init(invocation, handle, title, description, body, options) {
        super._init({styleClass: 'access-dialog'});

        this._invocation = invocation;
        this._handle = handle;

        this._requestExported = false;
        this._request = Gio.DBusExportedObject.wrapJSObject(RequestIface, this);

        for (let option in options)
            options[option] = options[option].deepUnpack();

        this._buildLayout(title, description, body, options);
    }

    _buildLayout(title, description, body, options) {
        // No support for non-modal system dialogs, so ignore the option
        // let modal = options['modal'] || true;
        let denyLabel = options['deny_label'] || _('Deny');
        let grantLabel = options['grant_label'] || _('Allow');
        let choices = options['choices'] || [];

        let content = new Dialog.MessageDialogContent({title, description});
        this.contentLayout.add_child(content);

        this._choices = new Map();

        for (let i = 0; i < choices.length; i++) {
            let [id, name, opts, selected] = choices[i];
            if (opts.length > 0)
                continue; // radio buttons, not implemented

            let check = new CheckBox.CheckBox();
            check.getLabelActor().text = name;
            check.checked = selected === 'true';
            content.add_child(check);

            this._choices.set(id, check);
        }

        if (body) {
            let bodyLabel = new St.Label({
                text: body,
                x_align: Clutter.ActorAlign.CENTER,
            });
            bodyLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            bodyLabel.clutter_text.line_wrap = true;
            content.add_child(bodyLabel);
        }

        this.addButton({
            label: denyLabel,
            action: () => this._sendResponse(DialogResponse.CANCEL),
            key: Clutter.KEY_Escape,
        });
        this.addButton({
            label: grantLabel,
            action: () => this._sendResponse(DialogResponse.OK),
        });
    }

    open() {
        if (!super.open())
            return false;

        let connection = this._invocation.get_connection();
        this._requestExported = this._request.export(connection, this._handle);
        return true;
    }

    CloseAsync(invocation, _params) {
        if (this._invocation.get_sender() !== invocation.get_sender()) {
            invocation.return_error_literal(
                Gio.DBusError,
                Gio.DBusError.ACCESS_DENIED,
                '');
            return;
        }

        this._sendResponse(DialogResponse.CLOSED);
    }

    _sendResponse(response) {
        if (this._requestExported)
            this._request.unexport();
        this._requestExported = false;

        let results = {};
        if (response === DialogResponse.OK) {
            for (let [id, check] of this._choices) {
                let checked = check.checked ? 'true' : 'false';
                results[id] = new GLib.Variant('s', checked);
            }
        }

        // Delay actual response until the end of the close animation (if any)
        this.connect('closed', () => {
            this._invocation.return_value(
                new GLib.Variant('(ua{sv})', [response, results]));
        });
        this.close();
    }
});

export class AccessDialogDBus {
    constructor() {
        this._accessDialog = null;

        this._windowTracker = Shell.WindowTracker.get_default();

        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(AccessIface, this);
        this._dbusImpl.export(Gio.DBus.session, '/org/freedesktop/portal/desktop');

        Gio.DBus.session.own_name('org.gnome.Shell.Portal', Gio.BusNameOwnerFlags.REPLACE, null, null);
    }

    _showDialog(params, invocation) {
        const [handle, , , title, description, body, options] = params;

        const dialog = new AccessDialog(
            invocation, handle, title, description, body, options);
        dialog.open();
        dialog.connect('closed', () => (this._accessDialog = null));

        this._accessDialog = dialog;
    }

    _armFocusChangeTimeout(params, invocation) {
        console.assert(!this._focusChangedId && !this._timeoutId);

        this._focusChangedId = this._windowTracker.connect('notify::focus-app', () => {
            const appId = params[1];

            if (appId && `${appId}.desktop` === this._windowTracker.focus_app.id) {
                GLib.source_remove(this._timeoutId);
                delete this._timeoutId;

                this._windowTracker.disconnect(this._focusChangedId);
                delete this._focusChangedId;

                this._showDialog(params, invocation);
            }
        });

        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, MONITOR_FOCUS_APP_TIMEOUT_MS,
            () => {
                this._windowTracker.disconnect(this._focusChangedId);
                delete this._focusChangedId;

                invocation.return_error_literal(
                    Gio.DBusError,
                    Gio.DBusError.ACCESS_DENIED,
                    'Only the focused app is allowed to show a system access dialog');

                delete this._timeoutId;
                return GLib.SOURCE_REMOVE;
            });
    }

    AccessDialogAsync(params, invocation) {
        if (this._accessDialog || this._timeoutId) {
            invocation.return_error_literal(
                Gio.DBusError,
                Gio.DBusError.LIMITS_EXCEEDED,
                'Already showing a system access dialog');
            return;
        }

        const appId = params[1];
        // We probably want to use parentWindow and global.display.focus_window
        // for this check in the future
        if (appId && `${appId}.desktop` !== this._windowTracker.focus_app?.id) {
            this._armFocusChangeTimeout(params, invocation);
            return;
        }

        this._showDialog(params, invocation);
    }
}
