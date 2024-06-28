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

import 'resource:///org/gnome/shell/ui/environment.js';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as TimeLimitsManager from 'resource:///org/gnome/shell/misc/timeLimitsManager.js';

// Convenience aliases
const {TimeLimitsState, UserState} = TimeLimitsManager;

/**
 * A harness for testing the `TimeLimitsManager` class. It simulates the passage
 * of time, maintaining an internal ordered queue of events, and providing three
 * groups of mock functions which the `TimeLimitsManager` uses to interact with
 * it: mock versions of GLib’s clock and timeout functions, a mock proxy of the
 * logind `User` D-Bus object, and a mock version of `Gio.Settings`.
 *
 * The internal ordered queue of events is sorted by time (in real/wall clock
 * seconds, i.e. UNIX timestamps). On each _tick(), the next event is shifted
 * off the head of the queue and processed. An event might be a simulated user
 * state change (mocking the user starting or stopping a session), a scheduled
 * timeout, or an assertion function for actually running test assertions.
 *
 * The simulated clock jumps from the scheduled time of one event to the
 * scheduled time of the next. This way, we can simulate half an hour of active
 * time (simulating usage) on the computer instantly.
 *
 * Times are provided as ISO 8601 date/time strings, to allow tests which span
 * multiple days to be written more easily. This simplifies things because the
 * daily time limit is reset at a specific time each morning.
 */
class TestHarness {
    constructor(settings, historyFileContents = null) {
        this._currentTimeSecs = 0;
        this._clockOffset = 100;  // make the monotonic clock lag by 100s, arbitrarily
        this._nextSourceId = 1;
        this._events = [];
        this._timeChangeNotify = null;
        this._timeChangeNotifySourceId = 0;
        this._settings = settings;

        // These two emulate relevant bits of the o.fdo.login1.User API
        // See https://www.freedesktop.org/software/systemd/man/latest/org.freedesktop.login1.html#User%20Objects
        this._currentUserState = 'active';
        this._currentUserIdleHint = false;

        this._loginUserPropertiesChangedCallback = null;

        // Create a fake history file containing the given contents. Or, if no
        // contents are given, reserve a distinct new history file name but then
        // delete it so it doesn’t exist for the manager.
        const [file, stream] = Gio.File.new_tmp('gnome-shell-time-limits-manager-test-XXXXXX.json');
        if (historyFileContents)
            stream.output_stream.write_bytes(new GLib.Bytes(historyFileContents), null);
        stream.close(null);
        if (!historyFileContents)
            file.delete(null);

        this._historyFile = file;

        // And a mock D-Bus proxy for logind.
        const harness = this;
        class MockLoginUser {
            connectObject(signalName, callback, unusedObject) {
                if (signalName === 'g-properties-changed') {
                    if (harness._loginUserPropertiesChangedCallback !== null)
                        fail('Duplicate g-properties-changed connection');
                    harness._loginUserPropertiesChangedCallback = callback;
                } else {
                    // No-op for mock purposes
                }
            }

            disconnectObject(unused) {
                // Very simple implementation for mock purposes
                harness._loginUserPropertiesChangedCallback = null;
            }

            get State() {
                return harness._currentUserState;
            }

            get IdleHint() {
                return harness._currentUserIdleHint;
            }
        }

        this._mockLoginUser = new MockLoginUser();
    }

    _cleanup() {
        this._historyFile?.delete(null);
    }

    _allocateSourceId() {
        const sourceId = this._nextSourceId;
        this._nextSourceId++;
        return sourceId;
    }

    _removeEventBySourceId(sourceId) {
        const idx = this._events.findIndex(a => {
            return a.sourceId === sourceId;
        });

        if (idx === -1)
            fail(`Removing non-existent source with ID ${sourceId}`);

        this._events.splice(idx, 1);
    }

    _insertEvent(event) {
        if (event.time < this._currentTimeSecs)
            fail(`Event ${event} cannot be before current mock clock time (${event.time} vs ${this._currentTimeSecs}`);

        this._events.push(event);
        this._events.sort((a, b) => {
            return a.time - b.time;
        });
        return event;
    }

    /**
     * Convert an ISO 8601 string to a UNIX timestamp for use in tests.
     *
     * Internally, the tests are all based on UNIX timestamps using wall clock
     * time. Those aren’t very easy to reason about when reading or writing
     * tests though, so we allow the tests to be written using ISO 8601 strings.
     *
     * @param {string} timeStr - date/time in ISO 8601 format
     */
    static timeStrToSecs(timeStr) {
        const dt = GLib.DateTime.new_from_iso8601(timeStr, null);
        if (dt === null)
            fail(`Time string ‘${timeStr}’ could not be parsed`);
        return dt.to_unix();
    }

    /**
     * Inverse of `timeStrToSecs()`.
     *
     * @param {number} timeSecs - UNIX real/wall clock time in seconds
     */
    _timeSecsToStr(timeSecs) {
        const dt = GLib.DateTime.new_from_unix_utc(timeSecs);
        if (dt === null)
            fail(`Time ‘${timeSecs}’ could not be represented`);
        return dt.format_iso8601();
    }

    /**
     * Add a timeout event to the event queue. It will be scheduled at the
     * current simulated time plus `intervalSecs`. `callback` will be invoked
     * when the event is processed.
     */
    addTimeoutEvent(intervalSecs, callback) {
        return this._insertEvent({
            type: 'timeout',
            time: this._currentTimeSecs + intervalSecs,
            callback,
            sourceId: this._allocateSourceId(),
            intervalSecs,
        });
    }

    /**
     * Add a time change event to the event queue. This simulates the machine’s
     * real time clock changing relative to its monotonic clock, at date/time
     * `timeStr`. Such a change can happen as the result of an NTP sync, for
     * example.
     *
     * When the event is reached, the mock real/wall clock will have its time
     * set to `newTimeStr`, and then `callback` will be invoked. `callback`
     * should be used to enqueue any events *after* the time change event. If
     * they are enqueued in the same scope as `addTimeChangeEvent()`, they will
     * be mis-ordered as the event queue is sorted by mock real/wall clock time.
     */
    addTimeChangeEvent(timeStr, newTimeStr, callback) {
        return this._insertEvent({
            type: 'time-change',
            time: TestHarness.timeStrToSecs(timeStr),
            newTime: TestHarness.timeStrToSecs(newTimeStr),
            callback,
        });
    }

    /**
     * Add a login user state change event to the event queue. This simulates
     * the [D-Bus API for logind](https://www.freedesktop.org/software/systemd/man/latest/org.freedesktop.login1.html#User%20Objects)
     * notifying that the user has changed state at date/time `timeStr`. For
     * example, this could represent the user logging out.
     *
     * @param {string} timeStr - date/time the event happens, in ISO 8601 format
     * @param {string} newState - new user state as if returned by
     *    [`sd_ui_get_state()`](https://www.freedesktop.org/software/systemd/man/latest/sd_uid_get_state.html)
     * @param {boolean} newIdleHint - new user idle hint as per
     *    [the logind API](https://www.freedesktop.org/software/systemd/man/latest/org.freedesktop.login1.html#User%20Objects)
     */
    addLoginUserStateChangeEvent(timeStr, newState, newIdleHint) {
        return this._insertEvent({
            type: 'login-user-state-change',
            time: TestHarness.timeStrToSecs(timeStr),
            newUserState: newState,
            newUserIdleHint: newIdleHint,
        });
    }

    /**
     * Add an assertion event to the event queue. This is a callback which is
     * invoked when the simulated clock reaches `timeStr`. The callback can
     * contain whatever test assertions you like.
     */
    addAssertionEvent(timeStr, callback) {
        return this._insertEvent({
            type: 'assertion',
            time: TestHarness.timeStrToSecs(timeStr),
            callback,
        });
    }

    /**
     * Add a shutdown action to the event queue. This shuts down the
     * `timeLimitsManager` at date/time `timeStr`, and asserts that the state
     * after shutdown is as expected.
     */
    shutdownManager(timeStr, timeLimitsManager) {
        return this._insertEvent({
            type: 'shutdown',
            time: TestHarness.timeStrToSecs(timeStr),
            timeLimitsManager,
        });
    }

    /**
     * Add a state assertion event to the event queue. This is a specialised
     * form of `addAssertionEvent()` which asserts that the
     * `TimeLimitsManager.state` equals `state` at date/time `timeStr`.
     */
    expectState(timeStr, timeLimitsManager, expectedState) {
        return this.addAssertionEvent(timeStr, () => {
            expect(TimeLimitsManager.timeLimitsStateToString(timeLimitsManager.state))
                .withContext(`${timeStr} state`)
                .toEqual(TimeLimitsManager.timeLimitsStateToString(expectedState));
        });
    }

    /**
     * Add a state assertion event to the event queue. This is a specialised
     * form of `addAssertionEvent()` which asserts that the given
     * `TimeLimitsManager` properties equal the expected values at date/time
     * `timeStr`.
     */
    expectProperties(timeStr, timeLimitsManager, expectedProperties) {
        return this.addAssertionEvent(timeStr, () => {
            for (const [name, expectedValue] of Object.entries(expectedProperties)) {
                expect(timeLimitsManager[name])
                    .withContext(`${timeStr} ${name}`)
                    .toEqual(expectedValue);
            }
        });
    }

    _popEvent() {
        return this._events.shift();
    }

    /**
     * Get a `Gio.File` for the mock history file.
     *
     * This file is populated when the `TestHarness` is created, and deleted
     * (as it’s a temporary file) after the harness is `run()`.
     *
     * @returns {Gio.File}
     */
    get mockHistoryFile() {
        return this._historyFile;
    }

    /**
     * Get a mock clock object for use in the `TimeLimitsManager` under test.
     * This provides a basic implementation of GLib’s clock and timeout
     * functions which use the simulated clock and event queue.
     */
    get mockClock() {
        return {
            get_real_time_secs: () => {
                return this._currentTimeSecs;
            },
            get_monotonic_time_secs: () => {
                return this._currentTimeSecs - this._clockOffset;
            },
            timeout_add_seconds: (priority, intervalSecs, callback) => {
                return this.addTimeoutEvent(intervalSecs, callback).sourceId;
            },
            source_remove: sourceId => {
                if (this._timeChangeNotify !== null &&
                    sourceId === this._timeChangeNotifySourceId) {
                    this._timeChangeNotify = null;
                    this._timeChangeNotifySourceId = 0;
                    return;
                }

                this._removeEventBySourceId(sourceId);
            },
            time_change_notify: (callback) => {
                if (this._timeChangeNotify !== null)
                    fail('Duplicate time_change_notify() call');

                this._timeChangeNotify = callback;
                this._timeChangeNotifySourceId = this._nextSourceId;
                this._nextSourceId++;
                return this._timeChangeNotifySourceId;
            },
        };
    }

    /**
     * Set the initial time for the mock real/wall clock.
     *
     * This will typically become the time that the mock user first becomes
     * active, when the `TimeLimitManager` is created.
     */
    initializeMockClock(timeStr) {
        if (this._currentTimeSecs !== 0)
            fail('mock clock already used');

        this._currentTimeSecs = TestHarness.timeStrToSecs(timeStr);
    }

    /**
     * Get a mock login user factory for use in the `TimeLimitsManager` under
     * test. This is an object providing constructors for `LoginUser` objects,
     * which are proxies around the
     * [`org.freedesktop.login1.User` D-Bus API](https://www.freedesktop.org/software/systemd/man/latest/org.freedesktop.login1.html#User%20Objects).
     * Each constructor returns a basic implementation of `LoginUser` which uses
     * the current state from `TestHarness`.
     *
     * This has an extra layer of indirection to match `mockSettingsFactory`.
     */
    get mockLoginUserFactory() {
        return {
            newAsync: () => {
                return this._mockLoginUser;
            },
        };
    }

    /**
     * Get a mock settings factory for use in the `TimeLimitsManager` under test.
     * This is an object providing constructors for `Gio.Settings` objects. Each
     * constructor returns a basic implementation of `Gio.Settings` which uses
     * the settings dictionary passed to `TestHarness` in its constructor.
     *
     * This necessarily has an extra layer of indirection because there are
     * multiple ways to construct a `Gio.Settings`.
     */
    get mockSettingsFactory() {
        return {
            new: schemaId => {
                return {
                    connectObject: (unused) => {
                        /* no-op for mock purposes */
                    },
                    get_boolean: key => {
                        return this._settings[schemaId][key];
                    },
                    get_uint: key => {
                        return this._settings[schemaId][key];
                    },
                };
            },
        };
    }

    _tick() {
        const event = this._popEvent();
        if (!event)
            return false;

        console.debug(`Test tick: ${event.type} at ${this._timeSecsToStr(event.time)}`);

        this._currentTimeSecs = event.time;

        switch (event.type) {
        case 'timeout':
            if (event.callback()) {
                event.time += event.intervalSecs;
                this._insertEvent(event);
            }
            break;
        case 'time-change':
            this._clockOffset += (event.newTime - this._currentTimeSecs);
            this._currentTimeSecs = event.newTime;

            if (event.callback !== null)
                event.callback();

            if (this._timeChangeNotify)
                this._timeChangeNotify();
            break;
        case 'login-user-state-change':
            this._currentUserState = event.newUserState;
            this._currentUserIdleHint = event.newUserIdleHint;

            if (this._loginUserPropertiesChangedCallback)
                this._loginUserPropertiesChangedCallback();
            break;
        case 'assertion':
            event.callback();
            break;
        case 'shutdown':
            event.timeLimitsManager.shutdown().catch(() => {});

            // FIXME: This doesn’t actually properly synchronise with the
            // completion of the shutdown() call
            this._insertEvent({
                type: 'assertion',
                time: event.time + 1,
                callback: () => {
                    expect(TimeLimitsManager.timeLimitsStateToString(event.timeLimitsManager.state))
                        .withContext(`Post-shutdown state`)
                        .toEqual(TimeLimitsManager.timeLimitsStateToString(TimeLimitsState.DISABLED));
                    expect(event.timeLimitsManager.dailyLimitTime)
                        .withContext(`Post-shutdown dailyLimitTime`)
                        .toEqual(0);
                },
            });
            break;
        default:
            fail('not reached');
        }

        return true;
    }

    /**
     * Run the test in a loop, blocking until all events are processed or an
     * exception is raised.
     */
    run() {
        console.debug('Starting new unit test');

        const loop = new GLib.MainLoop(null, false);
        let innerException = null;

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            try {
                if (this._tick())
                    return GLib.SOURCE_CONTINUE;
                loop.quit();
                return GLib.SOURCE_REMOVE;
            } catch (e) {
                // Quit the main loop then re-raise the exception
                loop.quit();
                innerException = e;
                return GLib.SOURCE_REMOVE;
            }
        });

        loop.run();

        this._cleanup();

        // Did we exit with an exception?
        if (innerException)
            throw innerException;
    }
}

describe('Time limits manager', () => {
    it('can be disabled via GSettings', function() {
        const harness = new TestHarness({
            'org.gnome.desktop.screen-time-limits': {
                'enabled': false,
                'daily-limit-seconds': 4 * 60 * 60,
            },
        });
        harness.initializeMockClock('2024-06-01T10:00:00Z');
        const timeLimitsManager = new TimeLimitsManager.TimeLimitsManager(harness.mockHistoryFile, harness.mockClock, harness.mockLoginUserFactory, harness.mockSettingsFactory);

        harness.expectState('2024-06-01T10:00:01Z', timeLimitsManager, TimeLimitsState.DISABLED);
        harness.expectState('2024-06-01T15:00:00Z', timeLimitsManager, TimeLimitsState.DISABLED);
        harness.addLoginUserStateChangeEvent('2024-06-01T15:00:10Z', 'active', false);
        harness.addLoginUserStateChangeEvent('2024-06-01T15:00:20Z', 'lingering', true);
        harness.expectProperties('2024-06-01T15:00:30Z', timeLimitsManager, {
            'state': TimeLimitsState.DISABLED,
            'dailyLimitTime': 0,
        });
        harness.shutdownManager('2024-06-01T15:10:00Z', timeLimitsManager);

        harness.run();
    });

    it('tracks a single day’s usage', function() {
        const harness = new TestHarness({
            'org.gnome.desktop.screen-time-limits': {
                'enabled': true,
                'daily-limit-seconds': 4 * 60 * 60,
            },
        });
        harness.initializeMockClock('2024-06-01T10:00:00Z');
        const timeLimitsManager = new TimeLimitsManager.TimeLimitsManager(harness.mockHistoryFile, harness.mockClock, harness.mockLoginUserFactory, harness.mockSettingsFactory);

        harness.expectState('2024-06-01T10:00:01Z', timeLimitsManager, TimeLimitsState.ACTIVE);
        harness.expectProperties('2024-06-01T13:59:59Z', timeLimitsManager, {
            'state': TimeLimitsState.ACTIVE,
            'dailyLimitTime': TestHarness.timeStrToSecs('2024-06-01T14:00:00Z'),
        });
        harness.expectState('2024-06-01T14:00:01Z', timeLimitsManager, TimeLimitsState.LIMIT_REACHED);
        harness.shutdownManager('2024-06-01T14:10:00Z', timeLimitsManager);

        harness.run();
    });

    it('resets usage at the end of the day', function() {
        const harness = new TestHarness({
            'org.gnome.desktop.screen-time-limits': {
                'enabled': true,
                'daily-limit-seconds': 4 * 60 * 60,
            },
        });
        harness.initializeMockClock('2024-06-01T10:00:00Z');
        const timeLimitsManager = new TimeLimitsManager.TimeLimitsManager(harness.mockHistoryFile, harness.mockClock, harness.mockLoginUserFactory, harness.mockSettingsFactory);

        harness.expectState('2024-06-01T10:00:01Z', timeLimitsManager, TimeLimitsState.ACTIVE);
        harness.expectProperties('2024-06-01T15:00:00Z', timeLimitsManager, {
            'state': TimeLimitsState.LIMIT_REACHED,
            'dailyLimitTime': TestHarness.timeStrToSecs('2024-06-01T14:00:00Z'),
        });
        harness.addLoginUserStateChangeEvent('2024-06-01T15:00:10Z', 'offline', true);

        // the next day (after 03:00 in the morning) usage should be reset:
        harness.expectProperties('2024-06-02T13:59:59Z', timeLimitsManager, {
            'state': TimeLimitsState.ACTIVE,
            'dailyLimitTime': 0,
        });
        harness.addLoginUserStateChangeEvent('2024-06-02T14:00:00Z', 'active', false);
        harness.expectProperties('2024-06-02T14:00:00Z', timeLimitsManager, {
            'state': TimeLimitsState.ACTIVE,
            'dailyLimitTime': TestHarness.timeStrToSecs('2024-06-02T18:00:00Z'),
        });

        // and that limit should be reached eventually
        harness.expectProperties('2024-06-02T18:00:01Z', timeLimitsManager, {
            'state': TimeLimitsState.LIMIT_REACHED,
            'dailyLimitTime': TestHarness.timeStrToSecs('2024-06-02T18:00:00Z'),
        });

        harness.shutdownManager('2024-06-02T18:10:00Z', timeLimitsManager);

        harness.run();
    });

    it('tracks usage correctly from an existing history file', function() {
        const harness = new TestHarness({
            'org.gnome.desktop.screen-time-limits': {
                'enabled': true,
                'daily-limit-seconds': 4 * 60 * 60,
            },
        }, JSON.stringify([
            {
                'oldState': UserState.INACTIVE,
                'newState': UserState.ACTIVE,
                'wallTimeSecs': TestHarness.timeStrToSecs('2024-06-01T07:30:00Z'),
            },
            {
                'oldState': UserState.ACTIVE,
                'newState': UserState.INACTIVE,
                'wallTimeSecs': TestHarness.timeStrToSecs('2024-06-01T08:00:00Z'),
            },
            {
                'oldState': UserState.INACTIVE,
                'newState': UserState.ACTIVE,
                'wallTimeSecs': TestHarness.timeStrToSecs('2024-06-01T08:30:00Z'),
            },
            {
                'oldState': UserState.ACTIVE,
                'newState': UserState.INACTIVE,
                'wallTimeSecs': TestHarness.timeStrToSecs('2024-06-01T09:30:00Z'),
            },
        ]));
        harness.initializeMockClock('2024-06-01T10:00:00Z');
        const timeLimitsManager = new TimeLimitsManager.TimeLimitsManager(harness.mockHistoryFile, harness.mockClock, harness.mockLoginUserFactory, harness.mockSettingsFactory);

        // The existing history file (above) lists two active periods,
        // 07:30–08:00 and 08:30–09:30 that morning. So the user should have
        // 2.5h left today.
        harness.expectState('2024-06-01T10:00:01Z', timeLimitsManager, TimeLimitsState.ACTIVE);
        harness.expectProperties('2024-06-01T12:29:59Z', timeLimitsManager, {
            'state': TimeLimitsState.ACTIVE,
            'dailyLimitTime': TestHarness.timeStrToSecs('2024-06-01T12:30:00Z'),
        });
        harness.expectState('2024-06-01T12:30:01Z', timeLimitsManager, TimeLimitsState.LIMIT_REACHED);
        harness.shutdownManager('2024-06-01T12:40:00Z', timeLimitsManager);

        harness.run();
    });

    it('immediately limits usage from an existing history file', function() {
        const harness = new TestHarness({
            'org.gnome.desktop.screen-time-limits': {
                'enabled': true,
                'daily-limit-seconds': 4 * 60 * 60,
            },
        }, JSON.stringify([
            {
                'oldState': UserState.INACTIVE,
                'newState': UserState.ACTIVE,
                'wallTimeSecs': TestHarness.timeStrToSecs('2024-06-01T04:30:00Z'),
            },
            {
                'oldState': UserState.ACTIVE,
                'newState': UserState.INACTIVE,
                'wallTimeSecs': TestHarness.timeStrToSecs('2024-06-01T08:50:00Z'),
            },
        ]));
        harness.initializeMockClock('2024-06-01T10:00:00Z');
        const timeLimitsManager = new TimeLimitsManager.TimeLimitsManager(harness.mockHistoryFile, harness.mockClock, harness.mockLoginUserFactory, harness.mockSettingsFactory);

        // The existing history file (above) lists one active period,
        // 04:30–08:50 that morning. So the user should have no time left today.
        harness.expectProperties('2024-06-01T10:00:01Z', timeLimitsManager, {
            'state': TimeLimitsState.LIMIT_REACHED,
            'dailyLimitTime': TestHarness.timeStrToSecs('2024-06-01T08:30:00Z'),
        });
        harness.shutdownManager('2024-06-01T10:10:00Z', timeLimitsManager);

        harness.run();
    });

    [
        '',
        'not valid JSON',
        '[]',
        '[{}]',
        '[{"newState": 1, "wallTimeSecs": 123}]',
        '[{"oldState": 0, "wallTimeSecs": 123}]',
        '[{"oldState": 0, "newState": 1}]',
        '[{"oldState": "not a number", "newState": 1, "wallTimeSecs": 123}]',
        '[{"oldState": 0, "newState": "not a number", "wallTimeSecs": 123}]',
        '[{"oldState": 0, "newState": 1, "wallTimeSecs": "not a number"}]',
        '[{"oldState": 666, "newState": 1, "wallTimeSecs": 123}]',
        '[{"oldState": 0, "newState": 666, "wallTimeSecs": 123}]',
        '[{"oldState": 0, "newState": 0, "wallTimeSecs": 123}]',
        '[{"oldState": 0, "newState": 1, "wallTimeSecs": 123},{"oldState": 1, "newState": 0, "wallTimeSecs": 1}]',
    ].forEach((invalidHistoryFileContents, idx) => {
        it(`ignores invalid history file syntax (test case ${idx + 1})`, function() {
            const harness = new TestHarness({
                'org.gnome.desktop.screen-time-limits': {
                    'enabled': true,
                    'daily-limit-seconds': 4 * 60 * 60,
                },
            }, invalidHistoryFileContents);
            harness.initializeMockClock('2024-06-01T10:00:00Z');
            const timeLimitsManager = new TimeLimitsManager.TimeLimitsManager(harness.mockHistoryFile, harness.mockClock, harness.mockLoginUserFactory, harness.mockSettingsFactory);

            // The existing history file (above) is invalid or a no-op and
            // should be ignored.
            harness.expectProperties('2024-06-01T10:00:01Z', timeLimitsManager, {
                'state': TimeLimitsState.ACTIVE,
                'dailyLimitTime': TestHarness.timeStrToSecs('2024-06-01T14:00:00Z'),
            });
            harness.shutdownManager('2024-06-01T10:10:00Z', timeLimitsManager);

            harness.run();
        });
    });

    it('expires old entries from an existing history file', function() {
        const harness = new TestHarness({
            'org.gnome.desktop.screen-time-limits': {
                'enabled': true,
                'daily-limit-seconds': 4 * 60 * 60,
            },
        }, JSON.stringify([
            // Old entries
            {
                'oldState': UserState.INACTIVE,
                'newState': UserState.ACTIVE,
                'wallTimeSecs': TestHarness.timeStrToSecs('2024-06-01T07:30:00Z') - 2 * TimeLimitsManager.HISTORY_THRESHOLD_SECONDS,
            },
            {
                'oldState': UserState.ACTIVE,
                'newState': UserState.INACTIVE,
                'wallTimeSecs': TestHarness.timeStrToSecs('2024-06-01T08:00:00Z') - 2 * TimeLimitsManager.HISTORY_THRESHOLD_SECONDS,
            },
            // Recent entries
            {
                'oldState': UserState.INACTIVE,
                'newState': UserState.ACTIVE,
                'wallTimeSecs': TestHarness.timeStrToSecs('2024-06-01T08:30:00Z'),
            },
            {
                'oldState': UserState.ACTIVE,
                'newState': UserState.INACTIVE,
                'wallTimeSecs': TestHarness.timeStrToSecs('2024-06-01T09:30:00Z'),
            },
        ]));
        harness.initializeMockClock('2024-06-01T10:00:00Z');
        const timeLimitsManager = new TimeLimitsManager.TimeLimitsManager(harness.mockHistoryFile, harness.mockClock, harness.mockLoginUserFactory, harness.mockSettingsFactory);

        // The existing history file (above) lists two active periods,
        // one of which is a long time ago and the other is ‘this’ morning in
        // June. After the manager is shut down and the history file stored
        // again, the older entry should have been expired.
        harness.expectState('2024-06-01T10:00:01Z', timeLimitsManager, TimeLimitsState.ACTIVE);
        harness.expectProperties('2024-06-01T12:29:59Z', timeLimitsManager, {
            'state': TimeLimitsState.ACTIVE,
            'dailyLimitTime': TestHarness.timeStrToSecs('2024-06-01T13:00:00Z'),
        });
        harness.shutdownManager('2024-06-01T12:40:00Z', timeLimitsManager);
        harness.addAssertionEvent('2024-06-01T12:50:00Z', () => {
            const [, historyContents] = harness.mockHistoryFile.load_contents(null);
            expect(JSON.parse(new TextDecoder().decode(historyContents)))
                .withContext('History file contents')
                .toEqual([
                    // Recent entries
                    {
                        'oldState': UserState.INACTIVE,
                        'newState': UserState.ACTIVE,
                        'wallTimeSecs': TestHarness.timeStrToSecs('2024-06-01T08:30:00Z'),
                    },
                    {
                        'oldState': UserState.ACTIVE,
                        'newState': UserState.INACTIVE,
                        'wallTimeSecs': TestHarness.timeStrToSecs('2024-06-01T09:30:00Z'),
                    },
                    // New entries
                    {
                        'oldState': UserState.INACTIVE,
                        'newState': UserState.ACTIVE,
                        'wallTimeSecs': TestHarness.timeStrToSecs('2024-06-01T10:00:00Z'),
                    },
                    {
                        'oldState': UserState.ACTIVE,
                        'newState': UserState.INACTIVE,
                        'wallTimeSecs': TestHarness.timeStrToSecs('2024-06-01T12:40:00Z'),
                    },
                ]);
        });

        harness.run();
    });

    it('expires future entries from an existing history file', function() {
        const harness = new TestHarness({
            'org.gnome.desktop.screen-time-limits': {
                'enabled': true,
                'daily-limit-seconds': 4 * 60 * 60,
            },
        }, JSON.stringify([
            {
                'oldState': UserState.INACTIVE,
                'newState': UserState.ACTIVE,
                'wallTimeSecs': TestHarness.timeStrToSecs('3000-06-01T04:30:00Z'),
            },
            {
                'oldState': UserState.ACTIVE,
                'newState': UserState.INACTIVE,
                'wallTimeSecs': TestHarness.timeStrToSecs('3000-06-01T08:50:00Z'),
            },
        ]));
        harness.initializeMockClock('2024-06-01T10:00:00Z');
        const timeLimitsManager = new TimeLimitsManager.TimeLimitsManager(harness.mockHistoryFile, harness.mockClock, harness.mockLoginUserFactory, harness.mockSettingsFactory);

        // The existing history file (above) lists one active period,
        // 04:30–08:50 that morning IN THE YEAR 3000. This could have resulted
        // from the clock offset changing while offline. Ignore it; the user
        // should still have their full limit for the day.
        harness.expectProperties('2024-06-01T10:00:01Z', timeLimitsManager, {
            'state': TimeLimitsState.ACTIVE,
            'dailyLimitTime': TestHarness.timeStrToSecs('2024-06-01T14:00:00Z'),
        });
        harness.shutdownManager('2024-06-01T10:10:00Z', timeLimitsManager);

        harness.run();
    });

    it('doesn’t count usage across time change events forwards', function() {
        const harness = new TestHarness({
            'org.gnome.desktop.screen-time-limits': {
                'enabled': true,
                'daily-limit-seconds': 4 * 60 * 60,
            },
        });
        harness.initializeMockClock('2024-06-01T10:00:00Z');
        const timeLimitsManager = new TimeLimitsManager.TimeLimitsManager(harness.mockHistoryFile, harness.mockClock, harness.mockLoginUserFactory, harness.mockSettingsFactory);

        // Use up 2h of the daily limit.
        harness.expectState('2024-06-01T10:00:01Z', timeLimitsManager, TimeLimitsState.ACTIVE);
        harness.expectProperties('2024-06-01T12:00:00Z', timeLimitsManager, {
            'state': TimeLimitsState.ACTIVE,
            'dailyLimitTime': TestHarness.timeStrToSecs('2024-06-01T14:00:00Z'),
        });

        harness.addTimeChangeEvent('2024-06-01T12:00:01Z', '2024-06-01T16:00:00Z', () => {
            // The following events are in the new time epoch. There should be
            // 2h of time limit left for the day.
            harness.expectProperties('2024-06-01T16:00:01Z', timeLimitsManager, {
                'state': TimeLimitsState.ACTIVE,
                'dailyLimitTime': TestHarness.timeStrToSecs('2024-06-01T17:59:59Z'),
            });

            harness.expectProperties('2024-06-01T18:00:00Z', timeLimitsManager, {
                'state': TimeLimitsState.LIMIT_REACHED,
                'dailyLimitTime': TestHarness.timeStrToSecs('2024-06-01T17:59:59Z'),
            });

            harness.shutdownManager('2024-06-01T18:10:00Z', timeLimitsManager);
        });

        harness.run();
    });

    it('doesn’t count usage across time change events backwards', function() {
        const harness = new TestHarness({
            'org.gnome.desktop.screen-time-limits': {
                'enabled': true,
                'daily-limit-seconds': 4 * 60 * 60,
            },
        });
        harness.initializeMockClock('2024-06-01T10:00:00Z');
        const timeLimitsManager = new TimeLimitsManager.TimeLimitsManager(harness.mockHistoryFile, harness.mockClock, harness.mockLoginUserFactory, harness.mockSettingsFactory);

        // Use up 2h of the daily limit.
        harness.expectState('2024-06-01T10:00:01Z', timeLimitsManager, TimeLimitsState.ACTIVE);
        harness.expectProperties('2024-06-01T12:00:00Z', timeLimitsManager, {
            'state': TimeLimitsState.ACTIVE,
            'dailyLimitTime': TestHarness.timeStrToSecs('2024-06-01T14:00:00Z'),
        });

        harness.addTimeChangeEvent('2024-06-01T12:00:01Z', '2024-06-01T09:00:00Z', () => {
            // The following events are in the new time epoch. There should be
            // 2h of time limit left for the day.
            harness.expectProperties('2024-06-01T09:00:01Z', timeLimitsManager, {
                'state': TimeLimitsState.ACTIVE,
                'dailyLimitTime': TestHarness.timeStrToSecs('2024-06-01T10:59:59Z'),
            });

            harness.expectProperties('2024-06-01T11:00:00Z', timeLimitsManager, {
                'state': TimeLimitsState.LIMIT_REACHED,
                'dailyLimitTime': TestHarness.timeStrToSecs('2024-06-01T10:59:59Z'),
            });

            harness.shutdownManager('2024-06-01T11:10:00Z', timeLimitsManager);
        });

        harness.run();
    });
});
