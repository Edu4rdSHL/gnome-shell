/* exported Indicator */
const GObject = imports.gi.GObject;

const Main = imports.ui.main;
const GnomeSession = imports.misc.gnomeSession;
const {QuickToggle, SystemIndicator} = imports.ui.quickSettings;

const StayAwakeToggle = GObject.registerClass(
class StayAwakeToggle extends QuickToggle {
    _init() {
        super._init({
            title: _('Stay Awake'),
            iconName: 'stay-awake-symbolic',
        });

        this._session = new GnomeSession.SessionManager();
        if (!this._session.g_name_owner) {
            this.hide();
            return;
        }
        this._cookie = null;

        this.connect('clicked', () => this._toggle());
        Main.sessionMode.connect('updated', () => this._sessionUpdated());
    }

    _enable() {
        this._cookie = this._session.InhibitSync('org.gnome.Shell', 0,
            'Stay Awake Enabled', GnomeSession.InhibitFlags.IDLE);
        this.checked = true;
    }

    _disable() {
        this._session.UninhibitSync(this._cookie);
        this._cookie = null;
        this.checked = false;
    }

    _toggle() {
        if (this._cookie == null)
            this._enable();
        else
            this._disable();
    }

    _sessionUpdated() {
        if (Main.sessionMode.isLocked)
            this._disable();
    }
});

var Indicator = GObject.registerClass(
class Indicator extends SystemIndicator {
    _init() {
        super._init();

        this._indicator = this._addIndicator();
        this._indicator.icon_name = 'stay-awake-symbolic';

        this._toggle = new StayAwakeToggle();
        this._toggle.connect('notify::checked', () => this._sync());
        this.quickSettingsItems.push(this._toggle);

        this._sync();
    }

    _sync() {
        this._indicator.visible = this._toggle.checked;
    }
});

