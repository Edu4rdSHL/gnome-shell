// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
//
// Copyright 2024 GNOME Foundation, Inc.
//
// This is a GNOME Shell component to support break reminders and screen time
// statistics.
//
// Licensed under the GNU General Public License Version 2
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License
// as published by the Free Software Foundation; either version 2
// of the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program; if not, write to the Free Software
// Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Gettext from 'gettext';
import * as Lightbox from '../ui/lightbox.js';
import * as Main from '../ui/main.js';
import * as MessageTray from '../ui/messageTray.js';
import * as SystemActions from './systemActions.js';

export const MIN_BREAK_LENGTH_SECONDS = 10;
const BREAK_OVERDUE_TIME_SECONDS = 60;  // time after a break is due when the user is notified it’s overdue
const BREAK_UPCOMING_NOTIFICATION_TIME_SECONDS = [2 * 60];  // notify the user 2min before a break is due; this must be kept in descending order
const BREAK_COUNTDOWN_TIME_SECONDS = 60;

const LIGHTBOX_FADE_TIME_SECONDS = 3;
const LIGHTBOX_FADE_FACTOR = 0.6;

/** @enum {number} */
const IdleState = {
    /* session is active */
    ACTIVE: 1,
    /* session is idle */
    IDLE: 2,
};

/** @enum {number} */
/* This enum is exposed over D-Bus (/org/gnome/Shell/ScreenTime) so is
 * effectively public API */
export const BreakState = {
    /* break reminders are disabled */
    DISABLED: 0,
    /* break reminders are enabled, user is active, no break is needed yet */
    ACTIVE: 1,
    /* user is idle, but no break is needed */
    IDLE: 2,
    /* a break is needed and the user is taking it */
    IN_BREAK: 3,
    /* a break is needed but the user is still active */
    BREAK_DUE: 4,
};

/* The code supports whatever break types the user wants. However, they each
 * need to be backed by a org.gnome.desktop.break-reminders.* child schema, and
 * those have to be pre-defined because they all have different default values.
 * So we need to validate the break types to prevent GSettings complaining about
 * non-installed schemas.
 *
 * So this needs to mirror the child schemas defined in
 * `schemas/org.gnome.desktop.break-reminders.gschema.xml.in` in
 * gsettings-desktop-schemas. */
const SUPPORTED_BREAK_TYPES = [
    'eyesight',
    'movement',
];

/**
 * Return a string form of `breakState`.
 *
 * @param {int} breakState The break state.
 * @returns {string} A string form of `breakState`.
 */
export function breakStateToString(breakState) {
    return Object.keys(BreakState).find(k => BreakState[k] === breakState);
}

let _singleton = null;

/**
 * @returns {BreakManager}
 */
export function getDefault() {
    if (_singleton === null)
        _singleton = new BreakManager();

    return _singleton;
}

/**
 * A manager class which tracks total active/inactive time and signals when the
 * user needs to take a break (according to their break reminder preferences).
 */
export const BreakManager = GObject.registerClass({
    Properties: {
        'state': GObject.ParamSpec.int(
            'state', '', '',
            GObject.ParamFlags.READABLE,
            BreakState.DISABLED, BreakState.BREAK_DUE, BreakState.DISABLED),
        'last-break-end-time': GObject.ParamSpec.uint64(
            'last-break-end-time', '', '',
            GObject.ParamFlags.READABLE,
            0, GLib.MAX_UINT64, 0),
        'next-break-due-time': GObject.ParamSpec.uint64(
            'next-break-due-time', '', '',
            GObject.ParamFlags.READABLE,
            0, GLib.MAX_UINT64, 0),
    },
    Signals: {
        'break-due': {},
        'break-finished': {},
        'take-break': {},
    },
}, class BreakManager extends GObject.Object {
    constructor(clock, idleMonitor, settingsFactory) {
        super();

        // Allow these two bits of global state to be overridden for unit testing
        this._idleMonitor = idleMonitor ?? global.backend.get_core_idle_monitor();
        this._clock = clock ?? {
            source_remove: GLib.source_remove,
            get_real_time_secs: () => {
                return GLib.get_real_time() / GLib.USEC_PER_SEC;
            },
            timeout_add_seconds: GLib.timeout_add_seconds,
        };
        this._settingsFactory = settingsFactory ?? {
            new: Gio.Settings.new,
            new_with_path: Gio.Settings.new_with_path,
        };
        this._breakSettings = this._settingsFactory.new('org.gnome.desktop.break-reminders');
        this._breakSettings.connect('changed', () => this._updateSettings());

        this._state = BreakState.DISABLED;
        this._breakTypeSettings = new Map();  // map of breakType to GSettings
        this._breakTypeSettingsChangedId = new Map();
        this._breakLastEnd = new Map();  // map of breakType to wall clock time (in seconds)
        this._idleWatchId = 0;
        this._activeWatchId = 0;
        this._timerId = 0;

        // Start tracking timings
        this._updateSettings();
    }

    _updateSettings() {
        // Load settings for each enabled type of break
        const selectedBreaks = this._breakSettings.get_strv('selected-breaks');

        if (!selectedBreaks || !selectedBreaks.length) {
            this._stopStateMachine();
            return false;
        }

        const currentTime = this.getCurrentTime();

        for (const breakType of SUPPORTED_BREAK_TYPES) {
            if (selectedBreaks.includes(breakType) &&
                !this._breakTypeSettings.has(breakType)) {
                // Enabling a previously disabled break
                const breakSettings = this._settingsFactory.new_with_path(
                    `org.gnome.desktop.break-reminders.${breakType}`,
                    `${this._breakSettings.path}${breakType}/`);
                this._breakTypeSettings.set(breakType, breakSettings);
                this._breakTypeSettingsChangedId.set(breakType,
                    breakSettings.connect('changed', () => this._updateState(this.getCurrentTime())));
                this._breakLastEnd.set(breakType, currentTime);
            } else if (!selectedBreaks.includes(breakType) &&
                       this._breakTypeSettings.has(breakType)) {
                // Disabling a previously enabled break
                const breakSettings = this._breakTypeSettings.get(breakType);
                breakSettings.disconnect(this._breakTypeSettingsChangedId.get(breakType));
                this._breakTypeSettings.delete(breakType);
                this._breakTypeSettingsChangedId.delete(breakType);
                this._breakLastEnd.delete(breakType);
            }
        }

        this.notify('next-break-due-time');

        if (this._state === BreakState.DISABLED)
            this._startStateMachine();

        return true;
    }

    _startStateMachine() {
        this._idleWatchId = this._idleMonitor.add_idle_watch(MIN_BREAK_LENGTH_SECONDS * 1000, this._onIdleWatch.bind(this));

        this._state = BreakState.ACTIVE;
        this._currentBreakType = null;
        this._currentBreakStartTime = 0;
        this._idleState = IdleState.ACTIVE;
        this._idleStartTime = 0;

        this._updateState(this.getCurrentTime());
    }

    _stopStateMachine() {
        if (this._idleWatchId !== 0)
            this._idleMonitor.remove_watch(this._idleWatchId);
        this._idleWatchId = 0;

        if (this._activeWatchId !== 0)
            this._idleMonitor.remove_watch(this._activeWatchId);
        this._activeWatchId = 0;

        if (this._timerId !== 0)
            this._clock.source_remove(this._timerId);
        this._timerId = 0;

        for (const [breakType, breakSettings] of this._breakTypeSettings)
            breakSettings.disconnect(this._breakTypeSettingsChangedId.get(breakType));
        this._breakTypeSettings = new Map();
        this._breakTypeSettingsChangedId = new Map();
        this._breakLastEnd = new Map();

        this._state = BreakState.DISABLED;
        this._currentBreakType = null;
        this._currentBreakStartTime = 0;
        this._idleState = IdleState.ACTIVE;
        this._idleStartTime = 0;

        this.notify('state');
    }

    _onIdleWatch() {
        console.assert(this._state !== BreakState.DISABLED, 'Idle received when manager is disabled');

        const currentTime = this.getCurrentTime();

        console.debug(`BreakManager: _onIdleWatch at ${currentTime}s`);

        // Start watching to see if the user becomes active again.
        if (this._activeWatchId === 0)
            this._activeWatchId = this._idleMonitor.add_user_active_watch(this._onUserActiveWatch.bind(this));

        this._idleState = IdleState.IDLE;
        this._idleStartTime = currentTime - MIN_BREAK_LENGTH_SECONDS;  /* already waited MIN_BREAK_LENGTH_SECONDS for the idle watch */
        this._updateState(currentTime);
    }

    _onUserActiveWatch() {
        console.assert(this._state !== BreakState.DISABLED, 'Active received when manager is disabled');

        const currentTime = this.getCurrentTime();

        console.debug(`BreakManager: _onUserActiveWatch at ${currentTime}s`);

        // Tidy up after the active watch, which is one-shot.
        // (The idle watch stays installed until explicitly removed.)
        this._idleMonitor.remove_watch(this._activeWatchId);
        this._activeWatchId = 0;

        this._idleState = IdleState.ACTIVE;
        this._updateState(currentTime);
    }

    /** Get the current real time, in seconds since the Unix epoch. */
    getCurrentTime() {
        return this._clock.get_real_time_secs();
    }

    _updateState(currentTime) {
        const idleTimeSeconds = currentTime - this._idleStartTime;

        if (this._idleState === IdleState.IDLE) {
            // What kind of break are we due, if any?
            const [dueBreakType, nextDueTime] = this.getNextBreakDue(currentTime);
            let inBreak = false;
            let dueBreakStartTime = 0;

            if (dueBreakType != null && nextDueTime <= currentTime) {
                const dueBreakTypeDuration = this._breakTypeSettings.get(dueBreakType).get_uint('duration-seconds');

                // Has the break been finished?
                if (nextDueTime + dueBreakTypeDuration <= currentTime) {
                    if (this._state === BreakState.IN_BREAK)
                        this.emit('break-finished');
                } else {
                    // Start a timer to announce the end of the break.
                    inBreak = true;
                    dueBreakStartTime = nextDueTime;
                    this._scheduleUpdateState(nextDueTime + dueBreakTypeDuration - currentTime);
                }
            } else if (nextDueTime !== 0) {
                // The user is idle but is not due a break. Store up the idle time
                // and update the break end times when the user next becomes active.
                // But also schedule a timer to notify the user about the start of
                // their scheduled break.
                console.assert(nextDueTime > currentTime, `nextDueTime (${nextDueTime}) should be greater than currentTime (${currentTime})`);
                this._scheduleUpdateState(nextDueTime - currentTime);
            }

            const newState = inBreak ? BreakState.IN_BREAK : BreakState.IDLE;
            if (this._state !== newState) {
                console.debug(`BreakManager: Changing state to ${breakStateToString(newState)}`);
                this._state = newState;
                this._currentBreakType = dueBreakType;
                this._currentBreakStartTime = dueBreakStartTime;
                this.notify('state');
            }
        } else if (this._idleState === IdleState.ACTIVE) {
            let emitBreakDue = false;

            this.freeze_notify();

            // How long was the user idle before becoming active? Use that to reset the break end times.
            // Reset every break type which is shorter than the idle time. This allows
            // the user to start a break a little early, or take an unexpected break,
            // and avoid their computer pestering them to take a break on schedule
            // shortly after they get back.
            console.debug(`BreakManager: idleStartTime: ${this._idleStartTime}s`);

            if (this._idleStartTime > 0) {
                for (const [breakType, breakTypeSettings] of this._breakTypeSettings) {
                    const breakTypeDuration = breakTypeSettings.get_uint('duration-seconds');

                    if (idleTimeSeconds >= breakTypeDuration)
                        this._breakLastEnd.set(breakType, currentTime);
                }

                this.notify('next-break-due-time');
                this.notify('last-break-end-time');
            }

            // Reset the idle start time state.
            this._idleStartTime = 0;

            // Are any breaks due now?
            const [dueBreakType, nextDueTime] = this.getNextBreakDue(currentTime);
            const isBreakDue = dueBreakType != null && nextDueTime <= currentTime;

            console.debug(`BreakManager: nextDueTime: ${nextDueTime}s, currentTime: ${currentTime}s, dueBreakType: ${dueBreakType}`);

            if (isBreakDue) {
                // Notify that a break is due if we haven’t done so already.
                if (this._state === BreakState.ACTIVE) {
                    this._state = BreakState.BREAK_DUE;
                    this._currentBreakType = dueBreakType;
                    this._currentBreakStartTime = nextDueTime;
                    this.notify('state');
                    emitBreakDue = true;
                }
            } else {
                if (nextDueTime !== 0) {
                    // Set a timer for when the next break is due.
                    console.assert(nextDueTime > currentTime, `nextDueTime (${nextDueTime}) should be greater than currentTime (${currentTime})`);
                    this._scheduleUpdateState(nextDueTime - currentTime);
                }

                if (this._state !== BreakState.ACTIVE) {
                    console.debug('BreakManager: Changing state to ACTIVE');
                    this._state = BreakState.ACTIVE;
                    this._currentBreakType = null;
                    this._currentBreakStartTime = 0;
                    this.notify('state');
                }
            }

            this.thaw_notify();
            if (emitBreakDue)
                this.emit('break-due');
        }
    }

    _scheduleUpdateState(timeout) {
        if (this._timerId !== 0)
            this._clock.source_remove(this._timerId);

        // Round up to avoid spinning
        const timeoutSeconds = Math.ceil(timeout);

        console.debug(`BreakManager: Scheduling state update in ${timeoutSeconds}s`);

        this._timerId = this._clock.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutSeconds, () => {
            this._timerId = 0;
            console.debug('BreakManager: Scheduled state update');
            this._updateState(this.getCurrentTime());
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Get a tuple of information about the break type which is currently due or
     * which will be due next.
     *  1. The type of break which is currently due or which will be due next,
     *     or `null` if no break is due.
     *  2. The time when the next break is due; if the first member of the tuple
     *     is non-null, then this is the time when that break was due. This is
     *     zero if no break types are enabled.
     */
    getNextBreakDue(currentTime) {
        let maxDuration = 0;
        let maxDurationType = null;
        let dueBreakTypes = [];
        let nextDueTime = 0;

        console.debug(`BreakManager: Current time: ${currentTime}s`);

        for (const [breakType, breakTypeSettings] of this._breakTypeSettings) {
            const breakTypeInterval = breakTypeSettings.get_uint('interval-seconds');
            const breakTypeDuration = breakTypeSettings.get_uint('duration-seconds');

            // Work out which break types are now due.
            const breakTypeWouldBeDueAt = this._breakLastEnd.get(breakType) + breakTypeInterval;
            const breakTypeIsDue = breakTypeWouldBeDueAt <= currentTime;

            console.debug(`BreakManager: Break type ${breakType}: would be due at ${breakTypeWouldBeDueAt}`);

            if (breakTypeIsDue) {
                dueBreakTypes.push(breakType);
                nextDueTime = breakTypeWouldBeDueAt;

                // Of the break types which are now due, which has the longest
                // duration?
                if (maxDuration === 0 || breakTypeDuration > maxDuration) {
                    maxDuration = breakTypeDuration;
                    maxDurationType = breakType;
                }
            } else if (nextDueTime === 0 || nextDueTime > breakTypeWouldBeDueAt) {
                // This break type isn’t due now, but when is it due?
                nextDueTime = breakTypeWouldBeDueAt;
                maxDurationType = breakType;
            }
        }

        console.debug(`BreakManager: Due break types: ${dueBreakTypes.length ? dueBreakTypes : '(none)'}, max duration type: ${maxDurationType}, next due time: ${nextDueTime}`);

        // maxDurationType is null and nextDueTime is zero if no break types are enabled
        return [maxDurationType, nextDueTime];
    }

    /**
     * Current state machine state.
     *
     * @type {BreakState}
     */
    get state() {
        return this._state;
    }

    /**
     * String identifier for the break type which is currently in progress or
     * due.
     *
     * Returns `null` if no break is currently due or happening.
     *
     * @type {?string}
     */
    get currentBreakType() {
        return this._currentBreakType;
    }

    /**
     * Start time for the break which is currently in progress , or `0` if no
     * break is in progress.
     *
     * If the user was idle before the break started, the start time will be
     * during the idle period, not the start of the idle period.
     *
     * @type {number}
     */
    get currentBreakStartTime() {
        if (this.state !== BreakState.IN_BREAK)
            return 0;

        return this._currentBreakStartTime;
    }

    /**
     * End time for the most recent break, or `0` if a break is currently in
     * progress or no breaks have happened yet.
     *
     * @type {number}
     */
    get lastBreakEndTime() {
        if (this.state === BreakState.IN_BREAK)
            return 0;

        return Math.max(0, ...this._breakLastEnd.values());
    }

    /**
     * Get the time when the next break is due. If a break is currently due,
     * then this is the time when that break was due. This is zero if no break
     * types are enabled.
     */
    getNextBreakDueTime(currentTime) {
        const [, nextDueTime] = this.getNextBreakDue(currentTime);
        return nextDueTime;
    }

    get nextBreakDueTime() {
        const currentTime = this.getCurrentTime();
        return this.getNextBreakDueTime(currentTime);
    }

    /**
     * Delays the currently upcoming, due or in-progress break.
     *
     * This is a no-op if no break is currently due or in progress.
     */
    delayBreak() {
        if (this.state === BreakState.DISABLED)
            return;

        const currentTime = this.getCurrentTime();

        console.debug('BreakManager: Delaying current break');

        // Increment all the last break end times for any break types which are
        // currently due by the delay. We do this over all break types, rather
        // than just the current break type, because multiple break types might
        // be due at the same time, and it would be a bit annoying to delay one
        // only for another break type to immediately become due.
        for (const [breakType, breakTypeSettings] of this._breakTypeSettings) {
            const breakTypeInterval = breakTypeSettings.get_uint('interval-seconds');
            const delaySecs = breakTypeSettings.get_uint('delay-seconds');

            if (this._breakLastEnd.get(breakType) + breakTypeInterval <= currentTime)
                this._breakLastEnd.set(breakType, this._breakLastEnd.get(breakType) + delaySecs);
        }

        this.freeze_notify();
        this.notify('next-break-due-time');
        this.notify('last-break-end-time');

        this._updateState(currentTime);
        this.thaw_notify();
    }

    /**
     * Skips the currently upcoming, due or in-progress break.
     *
     * This is a no-op if no break is currently due or in progress.
     */
    skipBreak() {
        if (this.state === BreakState.DISABLED)
            return;

        const currentTime = this.getCurrentTime();

        console.debug('BreakManager: Skipping current break');

        // Set all the last break end times for any break types which are
        // currently due to now. We do this over all break types, rather than
        // just the current break type, because multiple break types might be
        // due at the same time, and it would be a bit annoying to skip one only
        // for another break type to immediately become due.
        for (const [breakType, breakTypeSettings] of this._breakTypeSettings) {
            const breakTypeInterval = breakTypeSettings.get_uint('interval-seconds');

            if (this._breakLastEnd.get(breakType) + breakTypeInterval <= currentTime)
                this._breakLastEnd.set(breakType, currentTime);
        }

        this.freeze_notify();
        this.notify('next-break-due-time');
        this.notify('last-break-end-time');

        this._updateState(currentTime);
        this.thaw_notify();
    }

    /**
     * Signals that the user explicitly wants to start taking a break now, even
     * if they are technically still active.
     */
    takeBreak() {
        // We can’t force the user to be idle, but we can indicate to the break
        // dispatcher that it should try and make the user be idle.
        this.emit('take-break');
    }

    /** Whether the given breakType should emit notification popups to the user. */
    breakTypeShouldNotify(breakType) {
        if (!this._breakTypeSettings.has(breakType))
            return false;
        return this._breakTypeSettings.get(breakType).get_boolean('notify');
    }

    /**
     * Whether the given breakType should emit notification popups to the user
     * when it’s upcoming.
     */
    breakTypeShouldNotifyUpcoming(breakType) {
        if (!this._breakTypeSettings.has(breakType))
            return false;
        return this._breakTypeSettings.get(breakType).get_boolean('notify-upcoming');
    }

    /**
     * Whether the given breakType should emit notification popups to the user
     * if it’s overdue.
     */
    breakTypeShouldNotifyOverdue(breakType) {
        if (!this._breakTypeSettings.has(breakType))
            return false;
        return this._breakTypeSettings.get(breakType).get_boolean('notify-overdue');
    }

    /**
     * Whether the given breakType should show a prominent countdown for the
     * last 60s before it’s due.
     */
    breakTypeShouldCountdown(breakType) {
        if (!this._breakTypeSettings.has(breakType))
            return false;
        return this._breakTypeSettings.get(breakType).get_boolean('countdown');
    }

    /** Whether the given breakType should play sounds to notify the user. */
    breakTypeShouldPlaySound(breakType) {
        if (!this._breakTypeSettings.has(breakType))
            return false;
        return this._breakTypeSettings.get(breakType).get_boolean('play-sound');
    }

    /** Whether the given breakType should fade the screen during breaks. */
    breakTypeShouldFadeScreen(breakType) {
        if (!this._breakTypeSettings.has(breakType))
            return false;
        return this._breakTypeSettings.get(breakType).get_boolean('fade-screen');
    }

    /** Whether the given breakType should lock the screen during breaks. */
    breakTypeShouldLockScreen(breakType) {
        if (!this._breakTypeSettings.has(breakType))
            return false;
        return this._breakTypeSettings.get(breakType).get_boolean('lock-screen');
    }

    /** Duration (in seconds) of the given breakType. */
    getDurationForBreakType(breakType) {
        if (!this._breakTypeSettings.has(breakType))
            return 0;
        return this._breakTypeSettings.get(breakType).get_uint('duration-seconds');
    }
});

/**
 * Glue class which takes the state-based output from BreakManager and converts
 * it to event-based notifications/sounds/screen fades for the user to tell them
 * when to take breaks. It factors the user’s UI preferences into account.
 */
export const BreakDispatcher = GObject.registerClass(
class BreakDispatcher extends GObject.Object {
    constructor(manager) {
        super();

        this._manager = manager;
        this._previousState = BreakState.DISABLED;
        this._previousBreakType = null;
        this._manager.connectObject(
            'take-break', this._onTakeBreak.bind(this),
            'notify::state', this._onStateChanged.bind(this),
            'notify::next-break-due-time', this._onStateChanged.bind(this),
            this);

        this._systemActions = SystemActions.getDefault();

        this._notificationSource = new BreakNotificationSource(this._manager);
        this._notificationSource.connect('destroy', () => (this._notificationSource = null));
        Main.messageTray.add(this._notificationSource);

        this._lightbox = new Lightbox.Lightbox(Main.uiGroup, {
            inhibitEvents: false,
            fadeFactor: LIGHTBOX_FADE_FACTOR,
        });

        this._countdownOsd = null;
        this._countdownTimerId = 0;
    }

    destroy() {
        this._notificationSource?.destroy();
        this._notificationSource = null;

        this._lightbox?.destroy();
        this._lightbox = null;

        this._removeCountdown();

        this._previousState = BreakState.DISABLED;
        this._previousBreakType = null;

        this._manager.disconnectObject(this);
        this._manager = null;
    }

    _maybePlayCompleteSound() {
        if (this._manager.breakTypeShouldPlaySound(this._previousBreakType)) {
            const player = global.display.get_sound_player();

            player.play_from_theme('complete', _('Break complete sound'), null);
        }
    }

    _removeCountdown() {
        if (this._countdownTimerId !== 0)
            GLib.source_remove(this._countdownTimerId);
        this._countdownTimerId = 0;

        this._countdownOsd?.destroy();
        this._countdownOsd = null;
    }

    _onStateChanged() {
        switch (this._manager.state) {
        case BreakState.DISABLED:
            this.destroy();
            break;

        case BreakState.ACTIVE: {
            if (this._previousState === BreakState.IN_BREAK)
                this._maybePlayCompleteSound();

            this._lightbox?.lightOff();

            // Work out when the next break is due, and schedule a countdown.
            const currentTime = this._manager.getCurrentTime();
            const [nextBreakType, nextBreakDueTime] = this._manager.getNextBreakDue(currentTime);

            if (this._manager.breakTypeShouldCountdown(nextBreakType)) {
                const dueInSeconds = nextBreakDueTime - currentTime;
                const countdownStart = Math.max(dueInSeconds - BREAK_COUNTDOWN_TIME_SECONDS, 0);
                console.debug(`BreakDispatcher: Scheduling break countdown to start in ${countdownStart}s`);

                if (this._countdownTimerId !== 0)
                    GLib.source_remove(this._countdownTimerId);
                this._countdownTimerId = GLib.timeout_add_seconds(
                    GLib.PRIORITY_DEFAULT,
                    countdownStart, () => {
                        if (this._countdownOsd == null) {
                            this._countdownOsd = new OsdBreakCountdownLabel(this._manager);
                            this._countdownOsd.connect('destroy',
                                () => (this._countdownOsd = null));
                        }
                        this._countdownTimerId = 0;
                        return GLib.SOURCE_REMOVE;
                    });
            }

            break;
        }

        case BreakState.IDLE: {
            if (this._previousState === BreakState.IN_BREAK)
                this._maybePlayCompleteSound();

            this._lightbox?.lightOff();

            break;
        }

        case BreakState.IN_BREAK: {
            if (this._manager.breakTypeShouldLockScreen(this._manager.currentBreakType)) {
                this._systemActions.activateLockScreen();
            } else if (this._manager.breakTypeShouldFadeScreen(this._manager.currentBreakType)) {
                Main.uiGroup.set_child_above_sibling(this._lightbox, null);
                this._lightbox.lightOn(LIGHTBOX_FADE_TIME_SECONDS * 1000);
            }

            this._removeCountdown();

            break;
        }

        case BreakState.BREAK_DUE: {
            this._removeCountdown();

            break;
        }
        default:
            console.assert(false, `Unknown BreakManager state: ${this._manager.state}`);
            break;
        }

        this._previousState = this._manager.state;
        this._previousBreakType = this._manager.currentBreakType;
    }

    _onTakeBreak() {
        if (this._manager.breakTypeShouldLockScreen(this._manager.currentBreakType)) {
            this._systemActions.activateLockScreen();
        } else if (this._manager.breakTypeShouldFadeScreen(this._manager.currentBreakType)) {
            Main.uiGroup.set_child_above_sibling(this._lightbox, null);
            this._lightbox.lightOn(LIGHTBOX_FADE_TIME_SECONDS * 1000);
        }
    }
});

const BreakNotificationSource = GObject.registerClass(
class BreakNotificationSource extends MessageTray.Source {
    constructor(manager) {
        super({
            title: _('Wellbeing'),
            iconName: 'wellbeing-symbolic',
            // Allow the Source to hang around when empty, because we often
            // have a Notification object hanging around without being added
            // into the Source, so that it can track manager state. If the
            // Source was automatically destroyed when empty, this
            // Notification’s `source` property would be dangling.
            allowEmpty: true,
        });

        this._notification = null;
        this._timerId = 0;
        this._manager = manager;
        this._notifyStateId = this._manager.connect('notify::state', this._onStateChanged.bind(this));
        this._notifyNextId = this._manager.connect('notify::next-break-due-time', this._onStateChanged.bind(this));
        this.connect('destroy', this._onDestroy.bind(this));

        this._previousState = BreakState.DISABLED;
        this._previousBreakType = null;
        this._updateState();
    }

    _onDestroy() {
        if (this._notification !== null)
            this._notification.destroy();
        this._notification = null;

        if (this._timerId !== 0)
            GLib.source_remove(this._timerId);
        this._timerId = 0;

        if (this._manager != null && this._notifyStateId !== 0)
            this._manager.disconnect(this._notifyStateId);
        this._notifyStateId = 0;
        if (this._manager != null && this._notifyNextId !== 0)
            this._manager.disconnect(this._notifyNextId);
        this._notifyNextId = 0;
        this._manager = null;
    }

    _ensureNotification(params) {
        if (this._notification === null) {
            this._notification = new BreakNotification(this, this._manager);
            this._notification.connect('destroy', () => (this._notification = null));
        }

        this._notification.set(params);
    }

    /**
     * Formats the given time span as a translated string including units.
     * Returns a tuple of:
     *  1. The translated string
     *  2. The number which determines whether the string is plural, for use
     *     with `ngettext()` calls to embed the returned string into (as they
     *     will need plural handling).
     *  3. The number of seconds until the string would change if re-generated,
     *     for use in setting a timer to update a notification.
     *
     * @returns {Array}
     */
    _formatTimeSpan(secondsAgo) {
        const minutesAgo = secondsAgo / 60;
        const hoursAgo = minutesAgo / 60;
        const daysAgo = hoursAgo / 24;

        if (secondsAgo < 60) {
            return [Gettext.ngettext(
                '%d second',
                '%d seconds',
                secondsAgo
            ).format(secondsAgo), secondsAgo, 1];
        } else if (minutesAgo < 60) {
            return [Gettext.ngettext(
                '%d minute',
                '%d minutes',
                minutesAgo
            ).format(minutesAgo), minutesAgo, 60 - (secondsAgo % 60)];
        } else if (hoursAgo < 24) {
            return [Gettext.ngettext(
                '%d hour',
                '%d hours',
                hoursAgo
            ).format(hoursAgo), hoursAgo, (60 - (minutesAgo % 60)) * 60];
        } else {
            return [Gettext.ngettext(
                '%d day',
                '%d days',
                daysAgo
            ).format(daysAgo), daysAgo, (24 - (hoursAgo % 24)) * 60 * 60];
        }
    }

    _onStateChanged() {
        this._updateState();

        this._previousState = this._manager.state;
        this._previousBreakType = this._manager.currentBreakType;
    }

    _urgencyForBreakType(breakType) {
        console.assert(breakType != null, 'null breakType');

        // While the preferences indicate that certain break types should notify
        // and others shouldn’t, that’s not really possible: we only have one
        // notification which gets constantly updated with information about
        // breaks, interleaving messages from multiple breaks over time. Having
        // it disappear and reappear for different break types would be jarring.
        // Instead, set the urgency to LOW for break types which shouldn’t
        // notify. This means the notification remains, but is not presented to
        // the user — it’s just visible if they expand the message tray.
        if (this._manager.breakTypeShouldNotify(breakType))
            return MessageTray.Urgency.HIGH;
        else
            return MessageTray.Urgency.LOW;
    }

    _scheduleUpdateState(timeout) {
        if (this._timerId !== 0)
            GLib.source_remove(this._timerId);

        // Round up to avoid spinning
        const timeoutSeconds = Math.ceil(timeout);

        console.debug(`BreakNotificationSource: Scheduling notification state update in ${timeoutSeconds}s`);

        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutSeconds, () => {
            this._timerId = 0;
            console.debug('BreakNotificationSource: Scheduled notification state update');
            this._updateState();
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateState() {
        const currentTime = this._manager.getCurrentTime();

        console.debug(`BreakNotificationSource: Break notification source state changed from ${breakStateToString(this._previousState)} to ${breakStateToString(this._manager.state)}`);

        switch (this._manager.state) {
        case BreakState.DISABLED:
            this.destroy();
            break;

        case BreakState.ACTIVE: {
            if (this._previousState === BreakState.IN_BREAK) {
                // Break is complete.
                if (this._notification !== null)
                    this._notification.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
            } else {
                // Work out when the next break is due, and display some warnings
                // that it’s impending.
                const [nextBreakType, nextBreakDueTime] = this._manager.getNextBreakDue(currentTime);
                const remainingSecs = nextBreakDueTime - currentTime;
                console.debug(`BreakNotificationSource: ${remainingSecs}s left before next break`);

                if (this._manager.breakTypeShouldNotifyUpcoming(nextBreakType)) {
                    for (const notificationTime of BREAK_UPCOMING_NOTIFICATION_TIME_SECONDS) {
                        console.debug(`BreakNotificationSource: Considering upcoming notification ${notificationTime}s`);

                        if (remainingSecs > notificationTime) {
                            // Schedule to show the first (longest) notification
                            // which is less than the remaining time before the break.
                            this._scheduleUpdateState(remainingSecs - notificationTime);
                            break;
                        } else if (Math.ceil(remainingSecs) === notificationTime) {
                            // Bang on time to show this notification.
                            const [remainingText, remainingValue, unused] = this._formatTimeSpan(remainingSecs);
                            const bodyText = Gettext.ngettext(
                                /* %s will be replaced with a string that describes a time interval, such as “2 minutes”, “40 seconds” or “1 hour” */
                                'It will be time for a break in %s',
                                'It will be time for a break in %s',
                                remainingValue
                            ).format(remainingText);

                            let titleText;
                            switch (nextBreakType) {
                            case 'movement':
                                titleText = _('Movement Break Soon');
                                break;
                            case 'eyesight':
                                titleText = _('Eyesight Break Soon');
                                break;
                            default:
                                titleText = _('Break Soon');
                                break;
                            }

                            this._ensureNotification({
                                title: titleText,
                                body: bodyText,
                                iconName: 'wellbeing-symbolic',
                                sound: null,
                                acknowledged: false,
                                allowDelay: true,
                                allowSkip: true,
                                allowTake: false,
                            });
                            this.addNotification(this._notification);

                            // Continue to the next iteration, to schedule an update
                            // for the next-biggest notification.
                            continue;
                        }
                    }
                }
            }
            break;
        }

        case BreakState.IDLE: {
            // Do nothing.
            break;
        }

        case BreakState.IN_BREAK: {
            // Clamp to a minimum of 1s because saying “you have 0 seconds left”
            // is a bit odd. The state machine may remain in
            // `BreakState.IN_BREAK` even after the break duration is over,
            // because the user might remain idle. In that case, display no
            // further notifications until the user becomes active again — at
            // that point they get a ‘Break is over’ notification.
            const breakDurationRemaining = this._manager.getDurationForBreakType(this._manager.currentBreakType) - (currentTime - this._manager.currentBreakStartTime);

            if (breakDurationRemaining >= 1) {
                const [remainingText, remainingValue, updateTimeoutSeconds] = this._formatTimeSpan(breakDurationRemaining);

                let titleText, bodyText;
                switch (this._manager.currentBreakType) {
                case 'movement':
                    titleText = _('Movement Break in Progress');
                    bodyText = Gettext.ngettext(
                        /* %s will be replaced with a string that describes a time interval, such as “2 minutes”, “40 seconds” or “1 hour” */
                        'Continue moving around for %s',
                        'Continue moving around for %s',
                        remainingValue
                    ).format(remainingText);
                    break;
                case 'eyesight':
                    titleText = _('Eyesight Break in Progress');
                    bodyText = Gettext.ngettext(
                        /* %s will be replaced with a string that describes a time interval, such as “2 minutes”, “40 seconds” or “1 hour” */
                        'Continue looking away for %s',
                        'Continue looking away for %s',
                        remainingValue
                    ).format(remainingText);
                    break;
                default:
                    titleText = _('Break in Progress');
                    bodyText = Gettext.ngettext(
                        /* %s will be replaced with a string that describes a time interval, such as “2 minutes”, “40 seconds” or “1 hour” */
                        '%s left in your break',
                        '%s left in your break',
                        remainingValue
                    ).format(remainingText);
                    break;
                }

                this._ensureNotification({
                    title: titleText,
                    body: bodyText,
                    iconName: 'wellbeing-symbolic',
                    sound: null,
                    urgency: this._urgencyForBreakType(this._manager.currentBreakType),
                    acknowledged: false,
                    allowDelay: false,
                    allowSkip: false,
                    allowTake: false,
                });
                this.addNotification(this._notification);

                this._scheduleUpdateState(updateTimeoutSeconds);
            } else if (this._notification !== null) {
                this._notification.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
            }
            break;
        }

        case BreakState.BREAK_DUE: {
            const [nextBreakType, nextBreakDueTime] = this._manager.getNextBreakDue(currentTime);
            const breakDueAgo = currentTime - nextBreakDueTime;
            console.assert(breakDueAgo >= 0, 'breakDueAgo should be non-negative');

            if ((this._previousState === BreakState.ACTIVE ||
                 this._previousState === BreakState.DISABLED) &&
                breakDueAgo < BREAK_OVERDUE_TIME_SECONDS) {
                const durationSecs = this._manager.getDurationForBreakType(this._manager.currentBreakType);
                const [durationText, durationValue, unused] = this._formatTimeSpan(durationSecs);

                let titleText, bodyText;
                switch (this._manager.currentBreakType) {
                case 'movement':
                    titleText = _('Time for a Movement Break');
                    bodyText = Gettext.ngettext(
                        /* %s will be replaced with a string that describes a time interval, such as “2 minutes”, “40 seconds” or “1 hour” */
                        'Take a break from the computer and move around for %s',
                        'Take a break from the computer and move around for %s',
                        durationValue
                    ).format(durationText);
                    break;
                case 'eyesight':
                    titleText = _('Time for an Eyesight Break');
                    bodyText = Gettext.ngettext(
                        /* %s will be replaced with a string that describes a time interval, such as “2 minutes”, “40 seconds” or “1 hour” */
                        'Take a break from the screen. Look at least 6 meters away for at least %s',
                        'Take a break from the screen. Look at least 6 meters away for at least %s',
                        durationValue
                    ).format(durationText);
                    break;
                default:
                    titleText = _('Time for a Break');
                    bodyText = Gettext.ngettext(
                        /* %s will be replaced with a string that describes a time interval, such as “2 minutes”, “40 seconds” or “1 hour” */
                        'It’s time to take a break. Get away from the computer for %s!',
                        'It’s time to take a break. Get away from the computer for %s!',
                        durationValue
                    ).format(durationText);
                    break;
                }

                this._ensureNotification({
                    title: titleText,
                    body: bodyText,
                    iconName: 'wellbeing-symbolic',
                    sound: null,
                    acknowledged: false,
                    allowDelay: true,
                    allowSkip: false,
                    allowTake: true,
                });

                this._scheduleUpdateState(BREAK_OVERDUE_TIME_SECONDS);
            } else if (breakDueAgo >= BREAK_OVERDUE_TIME_SECONDS &&
                       this._manager.breakTypeShouldNotifyOverdue(nextBreakType)) {
                const [delayText, delayValue, updateTimeoutSeconds] = this._formatTimeSpan(breakDueAgo);
                const bodyText = Gettext.ngettext(
                    /* %s will be replaced with a string that describes a time interval, such as “2 minutes”, “40 seconds” or “1 hour” */
                    'You were due to take a break %s ago',
                    'You were due to take a break %s ago',
                    delayValue
                ).format(delayText);

                this._ensureNotification({
                    title: _('Break Overdue'),
                    body: bodyText,
                    iconName: 'wellbeing-symbolic',
                    sound: null,
                    acknowledged: false,
                    allowDelay: false,
                    allowSkip: false,
                    allowTake: false,
                });

                this._scheduleUpdateState(updateTimeoutSeconds);
            } else if (this._previousState === BreakState.IN_BREAK) {
                const durationSecs = this._manager.getDurationForBreakType(this._manager.currentBreakType);
                const [countdownText, countdownValue, updateTimeoutSeconds] = this._formatTimeSpan(durationSecs - breakDueAgo);
                const bodyText = Gettext.ngettext(
                    /* %s will be replaced with a string that describes a time interval, such as “2 minutes”, “40 seconds” or “1 hour” */
                    'There is %s remaining in your break',
                    'There are %s remaining in your break',
                    countdownValue
                ).format(countdownText);

                this._ensureNotification({
                    title: _('Break Interrupted'),
                    body: bodyText,
                    iconName: 'wellbeing-symbolic',
                    sound: null,
                    acknowledged: false,
                    allowDelay: false,
                    allowSkip: false,
                    allowTake: false,
                });

                this._scheduleUpdateState(updateTimeoutSeconds);
            }

            this._notification.urgency = this._urgencyForBreakType(this._manager.currentBreakType);
            this.addNotification(this._notification);
            break;
        }

        default:
            console.assert(false, `Unknown BreakManager state: ${this._manager.state}`);
            break;
        }
    }
});

const BreakNotification = GObject.registerClass({
    Properties: {
        'allow-delay': GObject.ParamSpec.boolean(
            'allow-delay', 'allow-delay', 'allow-delay',
            GObject.ParamFlags.READWRITE,
            false),
        'allow-skip': GObject.ParamSpec.boolean(
            'allow-skip', 'allow-skip', 'allow-skip',
            GObject.ParamFlags.READWRITE,
            false),
        'allow-take': GObject.ParamSpec.boolean(
            'allow-take', 'allow-take', 'allow-take',
            GObject.ParamFlags.READWRITE,
            false),
    },
}, class BreakNotification extends MessageTray.Notification {
    constructor(source, manager) {
        super({
            source,
            resident: true,
        });

        this._manager = manager;
        this.connect('destroy', this._onDestroy.bind(this));

        this._delayAction = null;
        this._skipAction = null;
        this._takeAction = null;
    }

    _onDestroy(_notification, destroyedReason) {
        // If it was destroyed by the user (by pressing the close button), skip
        // the current break.
        if (destroyedReason === MessageTray.NotificationDestroyedReason.DISMISSED)
            this._manager.skipBreak();

        this._manager = null;
    }

    get allowDelay() {
        return this._delayAction !== null;
    }

    set allowDelay(allowDelay) {
        if (allowDelay === this.allowDelay)
            return;

        if (allowDelay) {
            this._delayAction = this.addAction(_('Delay'), this._onDelayAction.bind(this));
        } else {
            this.removeAction(this._delayAction);
            this._delayAction = null;
        }
    }

    _onDelayAction() {
        this._manager.delayBreak();
        this.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
    }

    get allowSkip() {
        return this._skipAction !== null;
    }

    set allowSkip(allowSkip) {
        if (allowSkip === this.allowSkip)
            return;

        if (allowSkip) {
            this._skipAction = this.addAction(_('Skip'), this._onSkipAction.bind(this));
        } else {
            this.removeAction(this._skipAction);
            this._skipAction = null;
        }
    }

    _onSkipAction() {
        this._manager.skipBreak();
        this.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
    }

    get allowTake() {
        return this._takeAction !== null;
    }

    set allowTake(allowTake) {
        if (allowTake === this.allowTake)
            return;

        if (allowTake) {
            this._takeAction = this.addAction(_('Take'), this._onTakeAction.bind(this));
        } else {
            this.removeAction(this._takeAction);
            this._takeAction = null;
        }
    }

    _onTakeAction() {
        this._manager.takeBreak();
        this.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
    }
});

const OsdBreakCountdownLabel = GObject.registerClass(
class OsdBreakCountdownLabel extends St.Widget {
    constructor(manager) {
        super({x_expand: true, y_expand: true});

        this._manager = manager;
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            return this._updateState() ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        });

        this._box = new St.BoxLayout({
            vertical: true,
        });
        this.add_child(this._box);

        this._label = new St.Label({
            style_class: 'osd-break-countdown-label',
            text: '',
        });
        this._box.add_child(this._label);

        Main.uiGroup.add_child(this);
        Main.uiGroup.set_child_above_sibling(this, null);
        this._updateState();
        this._position();

        Meta.disable_unredirect_for_display(global.display);
        this.connect('destroy', () => {
            if (this._timerId !== 0)
                GLib.source_remove(this._timerId);
            this._timerId = 0;

            Meta.enable_unredirect_for_display(global.display);
        });
    }

    _updateState() {
        const currentTime = this._manager.getCurrentTime();
        const nextDueTime = this._manager.getNextBreakDueTime(currentTime);
        const breakDueInSecs = nextDueTime - currentTime;
        console.debug(`OsdBreakCountdownLabel: breakDueInSecs ${breakDueInSecs} nextDueTime ${nextDueTime} currentTime ${currentTime}`);

        if (breakDueInSecs < 1) {
            this.destroy();
            return false;
        }

        this._label.text = Gettext.ngettext(
            // Translators: This is a notification to warn the user that a
            // screen time break will start shortly.
            'Break in %d second',
            'Break in %d seconds',
            breakDueInSecs
        ).format(breakDueInSecs);

        return true;
    }

    _position() {
        let workArea = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);

        if (Clutter.get_default_text_direction() === Clutter.TextDirection.RTL)
            this._box.x = workArea.x + (workArea.width - this._box.width);
        else
            this._box.x = workArea.x;

        this._box.y = workArea.y;
    }
});
