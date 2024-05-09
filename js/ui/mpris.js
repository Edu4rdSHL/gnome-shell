import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import * as Main from './main.js';
import * as MessageList from './messageList.js';

import {loadInterfaceXML} from '../misc/fileUtils.js';

const DBusIface = loadInterfaceXML('org.freedesktop.DBus');
const DBusProxy = Gio.DBusProxy.makeProxyWrapper(DBusIface);

const MprisIface = loadInterfaceXML('org.mpris.MediaPlayer2');
const MprisProxy = Gio.DBusProxy.makeProxyWrapper(MprisIface);

const MprisPlayerIface = loadInterfaceXML('org.mpris.MediaPlayer2.Player');
const MprisPlayerProxy = Gio.DBusProxy.makeProxyWrapper(MprisPlayerIface);

const MPRIS_PLAYER_PREFIX = 'org.mpris.MediaPlayer2.';

const MediaMessage = GObject.registerClass(
class MediaMessage extends MessageList.Message {
    constructor(player) {
        super(player.source);

        this._player = player;
        this.add_style_class_name('media-message');

        this._prevButton = this.addMediaControl('media-skip-backward-symbolic',
            () => {
                this._player.previous();
            });

        this._playPauseButton = this.addMediaControl('',
            () => {
                this._player.playPause();
            });

        this._nextButton = this.addMediaControl('media-skip-forward-symbolic',
            () => {
                this._player.next();
            });

        this._player.connectObject('changed', this._update.bind(this), this);
        this._update();
    }

    vfunc_clicked() {
        this._player.raise();
        Main.panel.closeCalendar();
    }

    _updateNavButton(button, sensitive) {
        button.reactive = sensitive;
    }

    _update() {
        let icon;
        if (this._player.trackCoverUrl) {
            const file = Gio.File.new_for_uri(this._player.trackCoverUrl);
            icon = new Gio.FileIcon({file});
        } else {
            icon = new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'});
        }

        this.set({
            title: this._player.trackTitle,
            body: this._player.trackArtists.join(', '),
            icon,
        });

        let isPlaying = this._player.status === 'Playing';
        let iconName = isPlaying
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';
        this._playPauseButton.child.icon_name = iconName;

        this._updateNavButton(this._prevButton, this._player.canGoPrevious);
        this._updateNavButton(this._nextButton, this._player.canGoNext);
    }
});


export const MprisPlayer = GObject.registerClass({
    Properties: {
        'can-play': GObject.ParamSpec.boolean(
            'can-play', 'can-play', 'can-play',
            GObject.ParamFlags.READABLE,
            false),
    },
    Signals: {
        'changed': {},
    },
}, class MprisPlayer extends GObject.Object {
    constructor(busName) {
        super();

        this._mprisProxy = new MprisProxy(Gio.DBus.session, busName,
            '/org/mpris/MediaPlayer2',
            this._onMprisProxyReady.bind(this));
        this._playerProxy = new MprisPlayerProxy(Gio.DBus.session, busName,
            '/org/mpris/MediaPlayer2',
            this._onPlayerProxyReady.bind(this));

        this._canPlay = false;
        this._trackArtists = [];
        this._trackTitle = '';
        this._trackCoverUrl = '';
        this._busName = busName;
        this.source = new MessageList.Source();
    }

    get canPlay() {
        return this._canPlay;
    }

    get status() {
        return this._playerProxy.PlaybackStatus;
    }

    get trackArtists() {
        return this._trackArtists;
    }

    get trackTitle() {
        return this._trackTitle;
    }

    get trackCoverUrl() {
        return this._trackCoverUrl;
    }

    get app() {
        return this._app;
    }

    playPause() {
        this._playerProxy.PlayPauseAsync().catch(logError);
    }

    get canGoNext() {
        return this._playerProxy.CanGoNext;
    }

    next() {
        this._playerProxy.NextAsync().catch(logError);
    }

    get canGoPrevious() {
        return this._playerProxy.CanGoPrevious;
    }

    previous() {
        this._playerProxy.PreviousAsync().catch(logError);
    }

    raise() {
        // The remote Raise() method may run into focus stealing prevention,
        // so prefer activating the app via .desktop file if possible
        if (this._app)
            this._app.activate();
        else if (this._mprisProxy.CanRaise)
            this._mprisProxy.RaiseAsync().catch(logError);
    }

    _close() {
        this._mprisProxy.disconnectObject(this);
        this._mprisProxy = null;

        this._playerProxy.disconnectObject(this);
        this._playerProxy = null;
    }

    _onMprisProxyReady() {
        this._mprisProxy.connectObject('notify::g-name-owner',
            () => {
                if (!this._mprisProxy.g_name_owner)
                    this._close();
            }, this);
        // It is possible for the bus to disappear before the previous signal
        // is connected, so we must ensure that the bus still exists at this
        // point.
        if (!this._mprisProxy.g_name_owner)
            this._close();
    }

    _onPlayerProxyReady() {
        this._playerProxy.connectObject('g-properties-changed', this._updateState.bind(this), this);
        this._updateState();
    }

    _updateState() {
        let metadata = {};
        for (let prop in this._playerProxy.Metadata)
            metadata[prop] = this._playerProxy.Metadata[prop].deepUnpack();

        // Validate according to the spec; some clients send buggy metadata:
        // https://www.freedesktop.org/wiki/Specifications/mpris-spec/metadata
        this._trackArtists = metadata['xesam:artist'];
        if (!Array.isArray(this._trackArtists) ||
            !this._trackArtists.every(artist => typeof artist === 'string')) {
            if (typeof this._trackArtists !== 'undefined') {
                log(`Received faulty track artist metadata from ${
                    this._busName}; expected an array of strings, got ${
                    this._trackArtists} (${typeof this._trackArtists})`);
            }
            this._trackArtists =  [_('Unknown artist')];
        }

        this._trackTitle = metadata['xesam:title'];
        if (typeof this._trackTitle !== 'string') {
            if (typeof this._trackTitle !== 'undefined') {
                log(`Received faulty track title metadata from ${
                    this._busName}; expected a string, got ${
                    this._trackTitle} (${typeof this._trackTitle})`);
            }
            this._trackTitle = _('Unknown title');
        }

        this._trackCoverUrl = metadata['mpris:artUrl'];
        if (typeof this._trackCoverUrl !== 'string') {
            if (typeof this._trackCoverUrl !== 'undefined') {
                log(`Received faulty track cover art metadata from ${
                    this._busName}; expected a string, got ${
                    this._trackCoverUrl} (${typeof this._trackCoverUrl})`);
            }
            this._trackCoverUrl = '';
        }

        if (this._mprisProxy.DesktopEntry) {
            const desktopId = `${this._mprisProxy.DesktopEntry}.desktop`;
            this._app = Shell.AppSystem.get_default().lookup_app(desktopId);
        } else {
            this._app = null;
        }

        this.source.set({
            title: this._app?.get_name() ?? this._mprisProxy.Identity,
            icon: this._app?.get_icon() ?? null,
        });

        const canPlay = !!this._playerProxy.CanPlay;

        if (this.canPlay !== canPlay) {
            this._canPlay = canPlay;
            this.notify('can-play');
        }
        this.emit('changed');
    }
});

export const MediaSource = GObject.registerClass({
    Signals: {
        'player-added': {param_types: [MprisPlayer]},
        'player-removed': {param_types: [MprisPlayer]},
    },
}, class MediaSource extends GObject.Object {
    _init() {
        super._init();

        this._players = new Map();

        this._proxy = new DBusProxy(Gio.DBus.session,
            'org.freedesktop.DBus',
            '/org/freedesktop/DBus',
            this._onProxyReady.bind(this));
    }

    get players() {
        return [...this._players.values()];
    }

    _addPlayer(busName) {
        if (this._players.has(busName))
            return;

        const player = new MprisPlayer(busName);
        this._players.set(busName, player);

        player.connectObject('notify::can-play',
            () => {
                if (player.canPlay)
                    this.emit('player-added', player);
                else
                    this.emit('player-removed', player);
            }, this);
    }

    async _onProxyReady() {
        const [names] = await this._proxy.ListNamesAsync();
        names.forEach(name => {
            if (!name.startsWith(MPRIS_PLAYER_PREFIX))
                return;

            this._addPlayer(name);
        });
        this._proxy.connectSignal('NameOwnerChanged',
            this._onNameOwnerChanged.bind(this));
    }

    _onNameOwnerChanged(proxy, sender, [name, oldOwner, newOwner]) {
        if (!name.startsWith(MPRIS_PLAYER_PREFIX))
            return;

        if (oldOwner) {
            const player = this._players.get(name);
            if (player) {
                this._players.delete(name);
                player.disconnectObject(this);
                this.emit('player-removed', player);
            }
        }

        if (newOwner)
            this._addPlayer(name);
    }
});

export const MediaSection = GObject.registerClass(
class MediaSection extends MessageList.MessageListSection {
    constructor() {
        super();
        this._players = new Map();
        this._mediaSource = new MediaSource();

        this._mediaSource.connectObject(
            'player-added', (_, player) => this._addPlayer(player),
            'player-removed', (_, player) => this._removePlayer(player),
            this);

        this._mediaSource.players.forEach(player => {
            this._addPlayer(player);
        });
    }

    _addPlayer(player) {
        if (this._players.has(player))
            throw new Error('Player was already added previously');

        const message = new MediaMessage(player);
        this._players.set(player, message);
        this.addMessage(message, true);
    }

    _removePlayer(player) {
        const message = this._players.get(player);

        if (message)
            this.removeMessage(message, true);

        this._players.delete(player);
    }

    get allowed() {
        return !Main.sessionMode.isGreeter;
    }
});
