// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
//
// Copyright 2024 GNOME Foundation, Inc.
//
// This is a GNOME Shell component to support screen time limits and statistics.
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
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Gettext from 'gettext';
import * as LoginManager from './loginManager.js';
import * as Main from '../ui/main.js';
import * as MessageTray from '../ui/messageTray.js';
import * as SystemActions from './systemActions.js';

export const HISTORY_THRESHOLD_SECONDS = 14 * 7 * 24 * 60 * 60;  // maximum time history entries are kept
const LIMIT_UPCOMING_NOTIFICATION_TIME_SECONDS = 10 * 60;  // notify the user 10min before their limit is reached
const GRAYSCALE_FADE_TIME_SECONDS = 3;
const GRAYSCALE_SATURATION = 0.0;  // saturation ([0.0, 1.0]) when greyscale mode is activated, 1.0 means full colour

/** @enum {number} */
export const TimeLimitsState = {
    /* screen time limits are disabled */
    DISABLED: 0,
    /* screen time limits are enabled, but the limit has not been hit yet */
    ACTIVE: 1,
    /* limit has been reached */
    LIMIT_REACHED: 2,
};

/**
 * Return a string form of `timeLimitsState`.
 *
 * @param {int} timeLimitsState The time limit state.
 * @returns {string} A string form of `timeLimitsState`.
 */
export function timeLimitsStateToString(timeLimitsState) {
    return Object.keys(TimeLimitsState).find(k => TimeLimitsState[k] === timeLimitsState);
}

/** @enum {number} */
/* This enum is used in the saved state file, so is value mapping cannot be
 * changed. */
export const UserState = {
    INACTIVE: 0,
    ACTIVE: 1,
};

/**
 * Return a string form of `userState`.
 *
 * @param {int} userState The user state.
 * @returns {string} A string form of `userState`.
 */
function userStateToString(userState) {
    return Object.keys(UserState).find(k => UserState[k] === userState);
}

let _singleton = null;

/**
 * @returns {TimeLimitsManager}
 */
export function getDefault() {
    if (_singleton === null)
        _singleton = new TimeLimitsManager();

    return _singleton;
}

/**
 * A manager class which tracks total active/inactive time for a user, and
 * signals when the user has reached their daily time limit for actively using
 * the computer.
 *
 * Active/Inactive time is based off the total time the user account has spent
 * logged in to at least one active session, not idle (and not locked, but
 * that’s a subset of idle time).
 * This corresponds to the `active` state from sd_uid_get_state()
 * (https://www.freedesktop.org/software/systemd/man/latest/sd_uid_get_state.html),
 * plus `IdleHint` from
 * https://www.freedesktop.org/software/systemd/man/latest/org.freedesktop.login1.html#User Objects.
 * ‘Inactive’ time corresponds to all the other states from sd_uid_get_state(),
 * or if `IdleHint` is true.
 *
 * All times within the class are handled in terms of wall/real clock time,
 * rather than monotonic time. This is because it’s necessary to continue
 * counting time while the process or computer is suspended. If the real clock
 * is adjusted (e.g. as a result of an NTP sync) then everything has to be
 * recalculated. See `this._timeChangeId`.
 */
export const TimeLimitsManager = GObject.registerClass({
    Properties: {
        'state': GObject.ParamSpec.int(
            'state', '', '',
            GObject.ParamFlags.READABLE,
            TimeLimitsState.DISABLED, TimeLimitsState.LIMIT_REACHED, TimeLimitsState.DISABLED),
        'daily-limit-time': GObject.ParamSpec.uint64(
            'daily-limit-time', '', '',
            GObject.ParamFlags.READABLE,
            0, GLib.MAX_UINT64, 0),
        'grayscale-enabled': GObject.ParamSpec.boolean(
            'grayscale-enabled', '', '',
            GObject.ParamFlags.READABLE,
            false),
    },
    Signals: {
        'daily-limit-reached': {},
    },
}, class TimeLimitsManager extends GObject.Object {
    constructor(historyFile, clock, loginUserFactory, settingsFactory) {
        super();

        // Allow these few bits of global state to be overridden for unit testing
        const defaultHistoryFilePath = `${global.userdatadir}/session-active-history.json`;
        this._historyFile = historyFile ?? Gio.File.new_for_path(defaultHistoryFilePath);

        this._clock = clock ?? {
            source_remove: GLib.source_remove,
            get_real_time_secs: () => {
                return GLib.get_real_time() / GLib.USEC_PER_SEC;
            },
            get_monotonic_time_secs: () => {
                return GLib.get_monotonic_time() / GLib.USEC_PER_SEC;
            },
            timeout_add_seconds: GLib.timeout_add_seconds,
            time_change_notify: (callback) => {
                const timeChangeSource = Shell.time_change_source_new();
                timeChangeSource.set_callback(callback);
                return timeChangeSource.attach(null);
            },
        };
        this._loginUserFactory = loginUserFactory ?? {
            newAsync: () => {
                const loginManager = LoginManager.getLoginManager();
                return loginManager.getCurrentUserProxy();
            },
        };
        this._settingsFactory = settingsFactory ?? {
            new: Gio.Settings.new,
        };
        this._screenTimeLimitSettings = this._settingsFactory.new('org.gnome.desktop.screen-time-limits');
        this._screenTimeLimitSettings.connectObject(
            'changed', () => this._updateSettings(),
            'changed::daily-limit-seconds', () => this.emit('daily-limit-time'),
            'changed::grayscale', () => this.notify('grayscale-enabled'),
            this);

        this._state = TimeLimitsState.DISABLED;
        this._stateTransitions = [];
        this._cancellable = null;
        this._loginUser = null;
        this._lastStateChangeTimeSecs = 0;
        this._dailyLimitReachedAtSecs = 0;
        this._timerId = 0;
        this._timeChangeId = 0;
        this._clockOffsetSecs = 0;

        // Start tracking timings
        this._updateSettings();
    }

    _updateSettings() {
        if (!this._screenTimeLimitSettings.get_boolean('enabled')) {
            this._stopStateMachine().catch((e) => console.warn(`Failed to stop state machine: ${e.message}`));
            return false;
        }

        // If this is the first time _updateSettings() has been called, start
        // the state machine.
        if (this._state === TimeLimitsState.DISABLED)
            this._startStateMachine().catch((e) => console.warn(`Failed to start state machine: ${e.message}`));
        else
            this._updateState();

        return true;
    }

    async _startStateMachine() {
        // Start off active because gnome-shell is started inside the user’s
        // session, so by the time we get to this code, the user should be active.
        this._userState = UserState.ACTIVE;
        this._stateTransitions = [];
        this._state = TimeLimitsState.ACTIVE;
        this._cancellable = new Gio.Cancellable();

        this.freeze_notify();

        // Load the previously saved transitions. Discard any entries older than
        // the threshold, since we don’t care about historical data.
        try {
            await this._loadTransitions();
        } catch (e) {
            // Warn on failure, but carry on anyway.
            console.warn(`Failed to load screen time limits data: ${e.message}`);
        }

        // Add a fake transition to show the startup.
        if (this._stateTransitions.length === 0 ||
            this._userState !== UserState.ACTIVE) {
            const nowSecs = this.getCurrentTime();
            this._addTransition(UserState.INACTIVE, UserState.ACTIVE, nowSecs);
        }

        // Start listening for clock change notifications.
        this._clockOffsetSecs = this._getClockOffset();
        try {
            this._timeChangeId = this._clock.time_change_notify(() => {
                const newClockOffsetSecs = this._getClockOffset();
                const oldClockOffsetSecs = this._clockOffsetSecs;

                console.debug(`TimeLimitsManager: System clock changed, old offset ${oldClockOffsetSecs}s, new offset ${newClockOffsetSecs}s`);

                if (newClockOffsetSecs === oldClockOffsetSecs)
                    return GLib.SOURCE_CONTINUE;

                this._adjustAllTimes(newClockOffsetSecs - oldClockOffsetSecs);
                this._clockOffsetSecs = newClockOffsetSecs;

                this._storeTransitions().catch((e) => console.warn(`Failed to store screen time limits data: ${e.message}`));

                this.freeze_notify();
                this.notify('daily-limit-time');
                this._updateState();
                this.thaw_notify();

                return GLib.SOURCE_CONTINUE;
            });
        } catch (e) {
            console.warn(`Failed to listen for system clock changes: ${e.message}`);
            this._timeChangeId = 0;
        }

        // Start listening for notifications to the user’s state.
        this._loginUser = await this._loginUserFactory.newAsync();
        this._loginUser.connectObject(
            'g-properties-changed',
                () => this._updateUserState(true).catch((e) => console.warn(`Failed to update user state: ${e.message}`)),
            this);
        await this._updateUserState(false);
        this._updateState();

        this.thaw_notify();
    }

    async _stopStateMachine() {
        if (this._timeChangeId !== 0)
            this._clock.source_remove(this._timeChangeId);
        this._timeChangeId = 0;
        this._clockOffsetSecs = 0;

        if (this._timerId !== 0)
            this._clock.source_remove(this._timerId);
        this._timerId = 0;

        this._loginUser?.disconnectObject(this);
        this._loginUser = null;

        this._state = TimeLimitsState.DISABLED;
        this._lastStateChangeTimeSecs = 0;
        this._dailyLimitReachedAtSecs = 0;
        this.notify('state');

        // Add a fake transition to show the shutdown.
        if (this._userState !== UserState.INACTIVE) {
            const nowSecs = this.getCurrentTime();
            this._addTransition(UserState.ACTIVE, UserState.INACTIVE, nowSecs);
        }

        try {
            await this._storeTransitions();
        } catch (e) {
            console.warn(`Failed to store screen time limits data: ${e.message}`);
        }

        // Make sure no async operations are still pending.
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    /** Shut down the state machine and write out the state file. */
    async shutdown() {
        await this._stopStateMachine();
    }

    /** Get the current real time, in seconds since the Unix epoch. */
    getCurrentTime() {
        return this._clock.get_real_time_secs();
    }

    _getClockOffset() {
        return this._clock.get_real_time_secs() - this._clock.get_monotonic_time_secs();
    }

    /**
     * Adjust all the stored real/wall clock times by +`offsetSecs`.
     *
     * This is used when the system real clock changes with respect to the
     * monotonic clock (for example, after an NTP synchronisation). At that
     * point, all of the stored real/wall clock times have a constant non-zero
     * offset to the new real/wall clock time, which leads to incorrect
     * calculations of daily usage. Hence, they need to be adjusted.
     *
     * We can do this while the system is running. If the clock offset changes
     * while offline (for example, while another user is logged in instead), we
     * can’t do anything about it and will just have to skip erroneous old state
     * until everything eventually gets updated to the new clock by the passage
     * of time.
     *
     * It’s recommended to call `storeTransitions()` after this, as the
     * in-memory list of transitions is adjusted.
     *
     * @param {number} offsetSecs - the number of seconds to adjust times by; may be negative
     */
    _adjustAllTimes(offsetSecs) {
        console.assert(this._state !== TimeLimitsState.DISABLED, 'Time limits should not be disabled when adjusting times');

        console.debug(`TimeLimitsManager: Adjusting all times by ${offsetSecs}s`);

        for (let i = 0; i < this._stateTransitions.length; i++)
            this._stateTransitions[i].wallTimeSecs += offsetSecs;

        if (this._lastStateChangeTimeSecs !== 0)
            this._lastStateChangeTimeSecs += offsetSecs;

        if (this._dailyLimitReachedAtSecs !== 0)
            this._dailyLimitReachedAtSecs += offsetSecs;

        this._clockOffsetSecs += offsetSecs;
    }

    _calculateUserStateFromLogind() {
        return (this._loginUser.State === 'active' && !this._loginUser.IdleHint) ? UserState.ACTIVE : UserState.INACTIVE;
    }

    async _updateUserState(storeUpdates) {
        const oldState = this._userState;
        const newState = this._calculateUserStateFromLogind();

        if (oldState == newState)
            return;

        const nowSecs = this.getCurrentTime();
        this._addTransition(oldState, newState, nowSecs);
        if (storeUpdates) {
            try {
                await this._storeTransitions();
            } catch (e) {
                console.warn(`Failed to store screen time limits data: ${e.message}`);
            }
        }
    }

    _addTransition(oldState, newState, wallTimeSecs, recalculateState = true) {
        this._stateTransitions.push({
            oldState: oldState,
            newState: newState,
            wallTimeSecs: wallTimeSecs,
        });

        this._userState = newState;

        console.debug(`TimeLimitsManager: User state changed from ${userStateToString(oldState)} to ${userStateToString(newState)} at ${wallTimeSecs}s`);

        // This potentially changed the limit time and timeout calculations.
        if (recalculateState && this._state !== TimeLimitsState.DISABLED) {
            this.freeze_notify();
            this.notify('daily-limit-time');
            this._updateState();
            this.thaw_notify();
        }
    }

    /**
     * Load the transitions JSON file.
     *
     * The format is a top-level array. Each array element is an object
     * containing exactly the following elements:
     *  - `oldState`: integer value from `UserState`
     *  - `newState`: integer value from `UserState`
     *  - `wallTimeSecs`: number of seconds since the UNIX epoch at which the
     *       state transition happened
     *
     * `oldState` and `newState` must not be equal. `wallTimeSecs` must
     * monotonically increase from one array element to the next.
     *
     * The use of wall/real time in the file means its contents become invalid
     * if the system real time clock changes (relative to the monotonic clock).
     */
    async _loadTransitions() {
        const file = this._historyFile;

        let contents;
        try {
            const [, encodedContents] = await file.load_contents(this._cancellable);
            contents = new TextDecoder().decode(encodedContents);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                throw e;
            return;
        }

        const history = JSON.parse(contents);

        if (!Array.isArray(history))
            throw new Error(`${file.get_path()} does not contain an array`);

        const nowSecs = this.getCurrentTime();
        const validStates = Object.values(UserState);
        let previousWallTimeSecs = 0;

        this.freeze_notify();

        for (let i = 0; i < history.length; i++) {
            const entry = history[i];

            if (typeof entry !== 'object' ||
                entry === null ||
                !('oldState' in entry) ||
                !('newState' in entry) ||
                !('wallTimeSecs' in entry) ||
                !validStates.includes(entry['oldState']) ||
                !validStates.includes(entry['newState']) ||
                entry['oldState'] === entry['newState'] ||
                typeof(entry['wallTimeSecs']) !== 'number' ||
                entry['wallTimeSecs'] < previousWallTimeSecs) {
                this.thaw_notify();
                throw new Error(`Malformed entry (index ${i}) in ${file.get_path()}`);
            }

            // Skip entries older than the threshold, but always keep at least one.
            if (!this._filterOldTransition(entry, i, history, nowSecs))
                continue;

            this._addTransition(
                entry['oldState'],
                entry['newState'],
                entry['wallTimeSecs'],
                i === history.length - 1);
            previousWallTimeSecs = entry['wallTimeSecs'];
        }

        this.thaw_notify();
    }

    /**
     * Callback for Array.filter() to remove old entries from the transition array,
     * making sure to always keep the last one as a starting point for the future.
     *
     * Always drop entries which are in the future (even if that would remove
     * all history) as they can only exist as a result of file corruption or the
     * clock offset changing while we were offline. There’s nothing useful we
     * can recover from them.
     *
     * @returns {boolean} True to keep the entry, false to drop it.
     */
    _filterOldTransition(entry, idx, transitionsArray, nowSecs) {
        return (entry['wallTimeSecs'] <= nowSecs &&
                (entry['wallTimeSecs'] >= nowSecs - HISTORY_THRESHOLD_SECONDS || idx === transitionsArray.length - 1));
    }

    async _storeTransitions() {
        const file = this._historyFile;
        const nowSecs = this.getCurrentTime();

        console.debug(`TimeLimitsManager: Storing screen time limits data to ‘${file.peek_path()}’`);

        // Trim the transitions array to drop old history.
        this._stateTransitions = this._stateTransitions.filter(
            (e, i, a) => this._filterOldTransition(e, i, a, nowSecs));

        if (this._stateTransitions.length === 0) {
            try {
                await file.delete(this._cancellable);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    throw e;
            }
        } else {
            await file.replace_contents(
                JSON.stringify(this._stateTransitions), null, false,
                Gio.FileCreateFlags.PRIVATE, this._cancellable);
        }
    }

    /**
     * Get the Unix timestamp (in real seconds since the epoch) for the start of
     * today and the start of tomorrow.
     *
     * To avoid problems due to 24:00-01:00 not existing on leap days,
     * arbitrarily say that the day starts at 03:00.
     *
     * @type {number}
     */
    _getStartOfTodaySecs(nowSecs) {
        const nowDate = GLib.DateTime.new_from_unix_local(nowSecs);
        const startOfTodayDate = GLib.DateTime.new_local(
            nowDate.get_year(),
            nowDate.get_month(),
            nowDate.get_day_of_month(),
            3, 0, 0);
        const startOfTomorrowDate = startOfTodayDate.add_days(1);
        return [startOfTodayDate.to_unix(), startOfTomorrowDate.to_unix()];
    }

    /**
     * Work out how much time the user has spent at the screen today, in real
     * clock seconds.
     *
     * This is probably an under-estimate, because it uses the systemd-logind
     * ‘active’ user time, which is based on when the user’s logged in rather
     * than necessarily when they’re actively moving the mouse. Tracking the
     * latter is a lot more work, doesn’t take into account time spent in other
     * login sessions (e.g. KDE) and could be considered more invasive.
     *
     * If the system clock changes, this will become inaccurate until the set of
     * state transitions catches up. It will never return a negative number,
     * though.
     *
     * @type {number}
     */
    _calculateActiveTimeTodaySecs(nowSecs, startOfTodaySecs) {
        // NOTE: This might return -1.
        const firstTransitionTodayIdx = this._stateTransitions.findIndex((e) => e['wallTimeSecs'] >= startOfTodaySecs);

        let activeTimeTodaySecs = 0;
        // In case the first transition is active → inactive, or is unset.
        let activeStartTimeSecs = startOfTodaySecs;

        for (let i = firstTransitionTodayIdx; firstTransitionTodayIdx !== -1 && i < this._stateTransitions.length; i++) {
            if (this._stateTransitions[i]['newState'] === UserState.ACTIVE)
                activeStartTimeSecs = this._stateTransitions[i]['wallTimeSecs'];
            else if (this._stateTransitions[i]['oldState'] === UserState.ACTIVE)
                activeTimeTodaySecs += Math.max(this._stateTransitions[i]['wallTimeSecs'] - activeStartTimeSecs, 0);
        }

        if (this._stateTransitions.length > 0 &&
            this._stateTransitions[this._stateTransitions.length - 1]['newState'] === UserState.ACTIVE)
            activeTimeTodaySecs += Math.max(nowSecs - activeStartTimeSecs, 0);

        console.assert(activeTimeTodaySecs >= 0, 'Active time today should be non-negative even if system clock has changed');

        return activeTimeTodaySecs;
    }

    _updateState() {
        console.assert(this._state != TimeLimitsState.DISABLED, 'Time limits should not be disabled when updating timer');

        const nowSecs = this.getCurrentTime();
        const [startOfTodaySecs, startOfTomorrowSecs] = this._getStartOfTodaySecs(nowSecs);
        let newState = this._state;

        // Is it a new day since we last updated the state? If so, reset the
        // time limit.
        if (startOfTodaySecs > this._lastStateChangeTimeSecs) {
            newState = TimeLimitsState.ACTIVE;
        }

        // Work out how much time the user has spent at the screen today.
        const activeTimeTodaySecs = this._calculateActiveTimeTodaySecs(nowSecs, startOfTodaySecs);
        const dailyLimitSecs = this._screenTimeLimitSettings.get_uint('daily-limit-seconds');

        console.debug(`TimeLimitsManager: Active time today: ${activeTimeTodaySecs}s, daily limit ${dailyLimitSecs}s`);

        if (activeTimeTodaySecs >= dailyLimitSecs) {
            newState = TimeLimitsState.LIMIT_REACHED;

            // Schedule an update for when the limit will be reset again.
            this._scheduleUpdateState(startOfTomorrowSecs - nowSecs);
        } else if (this._userState === UserState.ACTIVE) {
            // Schedule an update for when we expect the limit will be reached.
            this._scheduleUpdateState(dailyLimitSecs - activeTimeTodaySecs);
        } else {
            // User is inactive, so no point scheduling anything until they become
            // active again.
        }

        // Update the saved state.
        if (newState != this._state) {
            this._state = newState;
            this._lastStateChangeTimeSecs = nowSecs;
            this.notify('state');
            this.notify('daily-limit-time');

            if (newState === TimeLimitsState.LIMIT_REACHED) {
                this._dailyLimitReachedAtSecs = nowSecs - (activeTimeTodaySecs - dailyLimitSecs);
                this.emit('daily-limit-reached');
            } else {
                this._dailyLimitReachedAtSecs = 0;
            }
        }
    }

    _scheduleUpdateState(timeout) {
        if (this._timerId !== 0)
            this._clock.source_remove(this._timerId);

        // Round up to avoid spinning
        const timeoutSeconds = Math.ceil(timeout);

        console.debug(`TimeLimitsManager: Scheduling state update in ${timeoutSeconds}s`);

        this._timerId = this._clock.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutSeconds, () => {
            this._timerId = 0;
            console.debug('TimeLimitsManager: Scheduled state update');
            this._updateState();
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * Current state machine state.
     *
     * @type {TimeLimitsState}
     */
    get state() {
        return this._state;
    }

    /**
     * The time when the daily limit will be reached. If the user is currently
     * active, and has not reached the limit, this is a non-zero value in the
     * future. If the user has already reached the limit, this is the time when
     * the limit was reached. If the user is inactive, and has not reached the
     * limit, or if time limits are disabled, this is zero.
     * It’s measured in real time seconds.
     *
     * @type {number}
     */
    get dailyLimitTime() {
        switch (this._state) {
        case TimeLimitsState.DISABLED:
            return 0;
        case TimeLimitsState.ACTIVE: {
            const nowSecs = this.getCurrentTime();
            const [startOfTodaySecs, ] = this._getStartOfTodaySecs(nowSecs);
            const activeTimeTodaySecs = this._calculateActiveTimeTodaySecs(nowSecs, startOfTodaySecs);
            const dailyLimitSecs = this._screenTimeLimitSettings.get_uint('daily-limit-seconds');

            console.assert(dailyLimitSecs >= activeTimeTodaySecs, 'Active time unexpectedly high');

            if (this._userState === UserState.ACTIVE)
                return nowSecs + (dailyLimitSecs - activeTimeTodaySecs);
            else
                return 0;
        }
        case TimeLimitsState.LIMIT_REACHED: {
            console.assert(this._dailyLimitReachedAtSecs > 0, 'Daily limit reached-at unexpectedly low');
            return this._dailyLimitReachedAtSecs;
        }
        default:
            console.assert(false, `Unexpected state ${this._state}`);
            return 0;
        }
    }

    /**
     * @type {boolean}
     */
    get grayscaleEnabled() {
        return this._screenTimeLimitSettings.get_boolean('grayscale');
    }
});

/**
 * Glue class which takes the state-based output from TimeLimitsManager and
 * converts it to event-based notifications for the user to tell them
 * when their time limit has been reached. It factors the user’s UI preferences
 * into account.
 */
export const TimeLimitsDispatcher = GObject.registerClass(
class TimeLimitsDispatcher extends GObject.Object {
    constructor(manager) {
        super();

        this._manager = manager;
        this._manager.connectObject(
            'notify::state', this._onStateChanged.bind(this),
            'notify::grayscale-enabled', this._onStateChanged.bind(this),
            this);

        this._notificationSource = null;
        this._desaturationOverlay = null;

        if (this._manager.state === TimeLimitsState.DISABLED)
            this._ensureDisabled();
        else
            this._ensureEnabled();
    }

    destroy() {
        this._ensureDisabled();

        this._manager.disconnectObject(this);
        this._manager = null;
    }

    _ensureEnabled() {
        if (this._notificationSource === null) {
            this._notificationSource = new TimeLimitsNotificationSource(this._manager);
            this._notificationSource.connect('destroy', () => (this._notificationSource = null));
            Main.messageTray.add(this._notificationSource);
        }

        // Create a new overlay at the very top level for the desaturation
        // effect. It needs to have a clone of the whole UI as its child, so
        // that it has something to apply the desaturation shader to. This makes
        // it work quite differently to, for example, `Lightbox`.
        if (this._desaturationOverlay === null) {
            this._desaturationOverlay = new Clutter.Actor();

            this._desaturationOverlay.add_effect(new Clutter.DesaturateEffect({name: 'desaturate'}));
            this._desaturationOverlay.get_effect('desaturate').set_enabled(false);
            this._desaturationOverlay.add_child(new Clutter.Clone({
                source: Main.uiGroup,
            }));

            global.stage.add_child(this._desaturationOverlay);
        }
    }

    _ensureDisabled() {
        this._notificationSource?.destroy();
        this._notificationSource = null;

        this._desaturationOverlay?.destroy();
        this._desaturationOverlay = null;
    }

    _onStateChanged() {
        switch (this._manager.state) {
        case TimeLimitsState.DISABLED:
            this._ensureDisabled();
            break;

        case TimeLimitsState.ACTIVE: {
            this._ensureEnabled();
            this._desaturationOverlay.hide();
            this._desaturationOverlay.get_effect('desaturate').set_enabled(false);

            break;
        }

        case TimeLimitsState.LIMIT_REACHED: {
            this._ensureEnabled();

            if (this._manager.grayscaleEnabled) {
                this._desaturationOverlay.show();
                this._desaturationOverlay.get_effect('desaturate').set_enabled(true);
                this._desaturationOverlay.remove_all_transitions();
                this._desaturationOverlay.ease_property(
                    '@effects.desaturate.factor', 1.0 - GRAYSCALE_SATURATION,
                    {
                        duration: GRAYSCALE_FADE_TIME_SECONDS * 1000 || 0,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
            } else {
                this._desaturationOverlay.hide();
                this._desaturationOverlay.get_effect('desaturate').set_enabled(false);
            }

            break;
        }
        default:
            console.assert(false, `Unknown TimeLimitsManager state: ${this._manager.state}`);
            break;
        }
    }
});

const TimeLimitsNotificationSource = GObject.registerClass(
class TimeLimitsNotificationSource extends MessageTray.Source {
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
        this._manager.connectObject(
            'notify::state', this._onStateChanged.bind(this),
            'notify::daily-limit-time', this._onStateChanged.bind(this),
            this);
        this.connect('destroy', this._onDestroy.bind(this));

        this._previousState = TimeLimitsState.DISABLED;
        this._updateState();
    }

    _onDestroy() {
        this._notification?.destroy();
        this._notification = null;

        if (this._timerId !== 0)
            GLib.source_remove(this._timerId);
        this._timerId = 0;

        this._manager?.disconnectObject(this);
        this._manager = null;
    }

    _ensureNotification(params) {
        if (this._notification === null) {
            this._notification = new TimeLimitsNotification(this);
            this._notification.connect('destroy', () => (this._notification = null));
        }

        // Unacknowledge the notification when it’s updated, by default.
        this._notification.set({acknowledged: false, ...params});
    }

    _onStateChanged() {
        this._updateState();

        this._previousState = this._manager.state;
    }

    _scheduleUpdateState(timeout) {
        if (this._timerId !== 0)
            GLib.source_remove(this._timerId);

        // Round up to avoid spinning
        const timeoutSeconds = Math.ceil(timeout);

        console.debug(`TimeLimitsNotificationSource: Scheduling notification state update in ${timeoutSeconds}s`);

        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutSeconds, () => {
            this._timerId = 0;
            console.debug('TimeLimitsNotificationSource: Scheduled notification state update');
            this._updateState();
            return GLib.SOURCE_REMOVE;
        });
    }

    _updateState() {
        const currentTime = this._manager.getCurrentTime();

        console.debug(`TimeLimitsNotificationSource: Time limits notification ` +
                      `source state changed from ` +
                      `${timeLimitsStateToString(this._previousState)} ` +
                      `to ${timeLimitsStateToString(this._manager.state)}`);

        switch (this._manager.state) {
        case TimeLimitsState.DISABLED:
            this.destroy();
            break;

        case TimeLimitsState.ACTIVE: {
            // Work out when the time limit will be, and display some warnings
            // that it’s impending.
            const limitDueTime = this._manager.dailyLimitTime;
            const remainingSecs = limitDueTime - currentTime;
            console.debug(`TimeLimitsNotificationSource: ${remainingSecs}s left before limit is reached`);

            if (remainingSecs > LIMIT_UPCOMING_NOTIFICATION_TIME_SECONDS) {
                // Schedule to show a notification when the upcoming notification
                // time is reached.
                this._scheduleUpdateState(remainingSecs - LIMIT_UPCOMING_NOTIFICATION_TIME_SECONDS);
                break;
            } else if (Math.ceil(remainingSecs) === LIMIT_UPCOMING_NOTIFICATION_TIME_SECONDS) {
                // Bang on time to show this notification.
                const remainingMinutes = Math.floor(LIMIT_UPCOMING_NOTIFICATION_TIME_SECONDS / 60);
                const titleText = Gettext.ngettext(
                    'Screen Time Limit in %d Minute',
                    'Screen Time Limit in %d Minutes',
                    remainingMinutes,
                ).format(remainingMinutes);

                this._ensureNotification({
                    title: titleText,
                    body: _('Your screen time limit is approaching'),
                    urgency: MessageTray.Urgency.HIGH,
                });
                this.addNotification(this._notification);
            }

            break;
        }

        case TimeLimitsState.LIMIT_REACHED: {
            // Notify the user that they’ve reached their limit, when we
            // transition from any state to LIMIT_REACHED.
            if (this._previousState !== TimeLimitsState.LIMIT_REACHED) {
                this._ensureNotification({
                    title: _('Screen Time Limit Reached'),
                    body: _('It’s time to stop using the computer'),
                    urgency: MessageTray.Urgency.HIGH,
                });
                this.addNotification(this._notification);
            }

            break;
        }

        default:
            console.assert(false, `Unknown TimeLimitsManager state: ${this._manager.state}`);
            break;
        }
    }
});

const TimeLimitsNotification = GObject.registerClass(
class TimeLimitsNotification extends MessageTray.Notification {
    constructor(source) {
        super({
            source,
            resident: true,
        });
    }
});
