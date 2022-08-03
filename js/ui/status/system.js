// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported Indicator */

const { GObject, Shell, St } = imports.gi;

const BoxPointer = imports.ui.boxpointer;
const SystemActions = imports.misc.systemActions;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;


var Indicator = GObject.registerClass(
class Indicator extends PanelMenu.SystemIndicator {
    _init() {
        super._init();

        this._systemActions = new SystemActions.getDefault();

        this._createSubMenu();

        // Whether shutdown is available or not depends on both lockdown
        // settings (disable-log-out) and Polkit policy - the latter doesn't
        // notify, so we update the menu item each time the menu opens or
        // the lockdown setting changes, which should be close enough.
        this.menu.connect('open-state-changed', (menu, open) => {
            if (!open)
                return;

            this._systemActions.forceUpdate();
        });
        this._updateSessionSubMenu();

        Main.sessionMode.connect('updated', this._sessionUpdated.bind(this));
        this._sessionUpdated();
    }

    _sessionUpdated() {
        this._settingsItem.visible = Main.sessionMode.allowSettings;
    }

    _updateSessionSubMenu() {
        this._sessionSubMenu.visible = !!this._sessionSubMenu.getVisibleItems().length;
    }

    _getSessionLabel() {
        if (this._systemActions.can_power_off && this._systemActions.can_logout)
            return _('Power Off / Log Out');

        if (this._systemActions.can_logout)
            return _('Log Out');

        if (this._systemActions.can_power_off)
            return _('Power Off');

        if (this._systemActions.can_suspend)
            return _('Suspend');

        return _('Power Off / Log Out');
    }

    _createSubMenu() {
        let bindFlags = GObject.BindingFlags.DEFAULT | GObject.BindingFlags.SYNC_CREATE;
        let item;

        let app = this._settingsApp = Shell.AppSystem.get_default().lookup_app(
            'org.gnome.Settings.desktop');
        if (app) {
            const [icon] = app.app_info.get_icon().names;
            const name = app.app_info.get_name();
            item = new PopupMenu.PopupImageMenuItem(name, icon);
            item.connect('activate', () => {
                this.menu.itemActivated(BoxPointer.PopupAnimation.NONE);
                Main.overview.hide();
                this._settingsApp.activate();
            });
            this.menu.addMenuItem(item);
            this._settingsItem = item;
        } else {
            log('Missing required core component Settings, expect trouble…');
            this._settingsItem = new St.Widget();
        }

        item = new PopupMenu.PopupImageMenuItem(_('Lock'), 'changes-prevent-symbolic');
        item.connect('activate', () => {
            this.menu.itemActivated(BoxPointer.PopupAnimation.NONE);
            this._systemActions.activateLockScreen();
        });
        this.menu.addMenuItem(item);
        this._systemActions.bind_property('can-lock-screen', item, 'visible', bindFlags);

        this._sessionSubMenu = new PopupMenu.PopupAutoSubMenuMenuItem(
            this._getSessionLabel(), true);
        this._sessionSubMenu.icon.icon_name = 'system-shutdown-symbolic';
        this._sessionSubMenu.connect('items-visibility-changed', () => {
            this._updateSessionSubMenu();
            this._sessionSubMenu.label.text = this._getSessionLabel();
        });

        item = new PopupMenu.PopupImageMenuItem(_('Suspend'), 'media-playback-pause-symbolic');
        item.setIconVisibility(false);
        item.connect('activate', () => {
            this.menu.itemActivated(BoxPointer.PopupAnimation.NONE);
            this._systemActions.activateSuspend();
        });
        this._sessionSubMenu.menu.addMenuItem(item);
        this._systemActions.bind_property('can-suspend', item, 'visible', bindFlags);

        item = new PopupMenu.PopupImageMenuItem(_('Restart…'), 'system-reboot-symbolic');
        item.setIconVisibility(false);
        item.connect('activate', () => {
            this.menu.itemActivated(BoxPointer.PopupAnimation.NONE);
            this._systemActions.activateRestart();
        });
        this._sessionSubMenu.menu.addMenuItem(item);
        this._systemActions.bind_property('can-restart', item, 'visible', bindFlags);

        item = new PopupMenu.PopupImageMenuItem(_('Power Off…'), 'system-shutdown-symbolic');
        item.setIconVisibility(false);
        item.connect('activate', () => {
            this.menu.itemActivated(BoxPointer.PopupAnimation.NONE);
            this._systemActions.activatePowerOff();
        });
        this._sessionSubMenu.menu.addMenuItem(item);
        this._systemActions.bind_property('can-power-off', item, 'visible', bindFlags);

        this._sessionSubMenu.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        item = new PopupMenu.PopupImageMenuItem(_('Log Out'), 'system-log-out-symbolic');
        item.setIconVisibility(false);
        item.connect('activate', () => {
            this.menu.itemActivated(BoxPointer.PopupAnimation.NONE);
            this._systemActions.activateLogout();
        });
        this._sessionSubMenu.menu.addMenuItem(item);
        this._systemActions.bind_property('can-logout', item, 'visible', bindFlags);

        item = new PopupMenu.PopupImageMenuItem(_('Switch User…'), 'system-switch-user-symbolic');
        item.setIconVisibility(false);
        item.connect('activate', () => {
            this.menu.itemActivated(BoxPointer.PopupAnimation.NONE);
            this._systemActions.activateSwitchUser();
        });
        this._sessionSubMenu.menu.addMenuItem(item);
        this._systemActions.bind_property('can-switch-user', item, 'visible', bindFlags);

        this.menu.addMenuItem(this._sessionSubMenu);
    }
});
