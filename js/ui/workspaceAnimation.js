// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Background from './background.js';
import * as Layout from './layout.js';
import * as SwipeTracker from './swipeTracker.js';
import * as Util from '../misc/util.js';

import * as Main from './main.js';

const WINDOW_ANIMATION_TIME = 250;
export const WORKSPACE_SPACING = 100;

export const WorkspaceGroup = GObject.registerClass(
class WorkspaceGroup extends Clutter.Actor {
    _init(workspace, monitor, movingWindow) {
        super._init({
            width: monitor.width,
            height: monitor.height,
            clip_to_allocation: true,
        });

        this._workspace = workspace;
        this._monitor = monitor;
        this._movingWindow = movingWindow;
        this._windowRecords = [];

        if (this._workspace) {
            this._background = new Meta.BackgroundGroup();

            this.add_child(this._background);

            this._bgManager = new Background.BackgroundManager({
                container: this._background,
                monitorIndex: this._monitor.index,
                controlPosition: false,
            });
            this._createDesktopWindows();
        }

        this._createWindows();

        this.connect('destroy', this._onDestroy.bind(this));
        global.display.connectObject('restacked',
            this._syncStacking.bind(this), this);
    }

    get monitor() {
        return this._monitor;
    }

    get workspace() {
        return this._workspace;
    }

    get movingWindow() {
        return this._movingWindow;
    }

    _shouldShowWindow(window) {
        if (!window.showing_on_its_workspace() || this._isDesktopWindow(window))
            return false;

        if (window.is_override_redirect())
            return false;

        if (!this._windowIsOnThisMonitor(window))
            return false;

        const isSticky =
            window.is_on_all_workspaces() || window === this._movingWindow;

        // No workspace means we should show windows that are on all workspaces
        if (!this._workspace)
            return isSticky;

        // Otherwise only show windows that are (only) on that workspace
        return !isSticky && window.located_on_workspace(this._workspace);
    }

    _syncStacking() {
        const windowActors = global.get_window_actors().filter(w =>
            this._shouldShowWindow(w.meta_window));

        let lastRecord;
        const bottomActor = this._background ?? null;

        for (const windowActor of windowActors) {
            const record = this._windowRecords.find(r => r.windowActor === windowActor);
            if (!record)
                continue;

            this.set_child_above_sibling(record.clone,
                lastRecord ? lastRecord.clone : bottomActor);
            lastRecord = record;
        }
    }

    _isDesktopWindow(metaWindow) {
        return metaWindow.get_window_type() === Meta.WindowType.DESKTOP;
    }

    _windowIsOnThisMonitor(metawindow) {
        const geometry = global.display.get_monitor_geometry(this._monitor.index);
        const [intersects] = metawindow.get_frame_rect().intersect(geometry);
        return intersects;
    }

    _createDesktopWindows() {
        const desktopActors = global.get_window_actors().filter(w => {
            return this._isDesktopWindow(w.meta_window) && this._windowIsOnThisMonitor(w.meta_window);
        });
        desktopActors.map(a => this._createClone(a)).forEach(clone => this._background.add_child(clone));
    }

    _createWindows() {
        const windowActors = global.get_window_actors().filter(w =>
            this._shouldShowWindow(w.meta_window));

        windowActors.map(a => this._createClone(a)).forEach(clone => this.add_child(clone));
    }

    _createClone(windowActor) {
        const clone = new Clutter.Clone({
            source: windowActor,
            x: windowActor.x - this._monitor.x,
            y: windowActor.y - this._monitor.y,
        });

        const record = {windowActor, clone};

        windowActor.connectObject('destroy', () => {
            clone.destroy();
            this._windowRecords.splice(this._windowRecords.indexOf(record), 1);
        }, this);

        this._windowRecords.push(record);
        return clone;
    }

    _removeWindows() {
        for (const record of this._windowRecords)
            record.clone.destroy();

        this._windowRecords = [];
    }

    _onDestroy() {
        this._removeWindows();

        if (this._workspace)
            this._bgManager.destroy();
    }
});

export const MonitorGroup = GObject.registerClass({
    Properties: {
        'progress': GObject.ParamSpec.double(
            'progress', 'progress', 'progress',
            GObject.ParamFlags.READWRITE,
            -Infinity, Infinity, 0),
    },
}, class MonitorGroup extends St.Widget {
    _init(monitor, workspaceIndices, movingWindow) {
        super._init({
            clip_to_allocation: true,
            style_class: 'workspace-animation',
        });

        this._monitor = monitor;

        const constraint = new Layout.MonitorConstraint({index: monitor.index});
        this.add_constraint(constraint);

        this._container = new Clutter.Actor();
        this.add_child(this._container);

        const stickyGroup = new WorkspaceGroup(null, monitor, movingWindow);
        this.add_child(stickyGroup);

        this._workspaceGroups = [];
        this._workspaceIndices = [];
        this._movingWindow = movingWindow;

        const workspaceManager = global.workspace_manager;
        const activeWorkspace = workspaceManager.get_active_workspace();

        this._updateBaseDistance();
        St.ThemeContext.get_for_stage(global.stage).connectObject(
            'notify::scale-factor', () => this._updateBaseDistance(), this);
        Main.layoutManager.connectObject('monitors-changed',
            () => this._updateBaseDistance(), this);

        this.setWorkspaceIndices(workspaceIndices);

        this.progress = this.getWorkspaceProgress(activeWorkspace);

        if (monitor.index === Main.layoutManager.primaryIndex) {
            this._workspacesAdjustment = Main.createWorkspacesAdjustment(this);
            this.bind_property_full('progress',
                this._workspacesAdjustment, 'value',
                GObject.BindingFlags.SYNC_CREATE,
                (_bind, source) => {
                    const indices = [
                        this._workspaceIndices[Math.floor(source)],
                        this._workspaceIndices[Math.ceil(source)],
                    ];
                    return [true, Util.lerp(...indices, source % 1.0)];
                },
                null);

            this.connect('destroy', () => {
                delete this._workspacesAdjustment;
            });
        }
    }

    _updateBaseDistance() {
        this._baseDistance = global.workspace_manager.layout_rows === -1
            ? this._monitor.height : this._monitor.width;
        this._baseDistance += WORKSPACE_SPACING *
            St.ThemeContext.get_for_stage(global.stage).scaleFactor;
    }

    setWorkspaceIndices(workspaceIndices) {
        const {workspaceManager} = global;
        const vertical = workspaceManager.layout_rows === -1;

        let x = 0;
        let y = 0;

        let oldFirstGroup;
        const oldGroups = this._workspaceGroups;
        this._workspaceGroups = [];
        this._container.remove_all_children();

        for (const i of workspaceIndices) {
            const ws = workspaceManager.get_workspace_by_index(i);
            const fullscreen = ws.list_windows().some(w =>
                w.get_monitor() === this._monitor.index && w.is_fullscreen());

            if (i > 0 && vertical && !fullscreen &&
                this._monitor.index === Main.layoutManager.primaryIndex) {
                // We have to shift windows up or down by the height of the panel to prevent having a
                // visible gap between the windows while switching workspaces. Since fullscreen windows
                // hide the panel, they don't need to be shifted up or down.
                y -= Main.panel.height;
            }

            let group;
            let groupIndex = oldGroups.findIndex(g =>
                g.workspace === ws && g.monitor === this._monitor &&
                g.movingWindow === this._movingWindow);
            if (groupIndex === -1) {
                group = new WorkspaceGroup(ws, this._monitor, this._movingWindow);
            } else {
                [group] = oldGroups.splice(groupIndex, 1);

                if (!oldFirstGroup && group.x === 0 && group.y === 0)
                    oldFirstGroup = group;
            }

            this._workspaceGroups.push(group);
            this._container.add_child(group);
            group.set_position(x, y);

            if (vertical)
                y += this.baseDistance;
            else if (Clutter.get_default_text_direction() === Clutter.TextDirection.RTL)
                x -= this.baseDistance;
            else
                x += this.baseDistance;
        }

        if (oldFirstGroup) {
            if (vertical)
                this._container.y -= oldFirstGroup.y;
            else
                this._container.x -= oldFirstGroup.x;
        }

        oldGroups.forEach(g => g.destroy());
        this._workspaceIndices = workspaceIndices;
    }

    addWorkspaceIndex(wsIndex) {
        const indices = new Set([...this._workspaceIndices, wsIndex]);
        this.setWorkspaceIndices([...indices].sort((a, b) => a - b));
    }

    get workspaceIndices() {
        return this._workspaceIndices;
    }

    set movingWindow(movingWindow) {
        if (this._movingWindow === movingWindow)
            return;

        this._movingWindow = movingWindow;
        this.setWorkspaceIndices(this._workspaceIndices);
    }

    get movingWindow() {
        return this._movingWindow;
    }

    get baseDistance() {
        return this._baseDistance;
    }

    get progress() {
        if (global.workspace_manager.layout_rows === -1)
            return -this._container.y / this.baseDistance;
        else if (this.get_text_direction() === Clutter.TextDirection.RTL)
            return this._container.x / this.baseDistance;
        else
            return -this._container.x / this.baseDistance;
    }

    set progress(p) {
        if (global.workspace_manager.layout_rows === -1)
            this._container.y = -Math.round(p * this.baseDistance);
        else if (this.get_text_direction() === Clutter.TextDirection.RTL)
            this._container.x = Math.round(p * this.baseDistance);
        else
            this._container.x = -Math.round(p * this.baseDistance);

        this.notify('progress');
    }

    get index() {
        return this._monitor.index;
    }

    getWorkspaceProgress(workspace) {
        const group = this._workspaceGroups.find(g =>
            g.workspace.index() === workspace.index());
        return this._getWorkspaceGroupProgress(group);
    }

    _getWorkspaceGroupProgress(group) {
        if (global.workspace_manager.layout_rows === -1)
            return group.y / this.baseDistance;
        else if (this.get_text_direction() === Clutter.TextDirection.RTL)
            return -group.x / this.baseDistance;
        else
            return group.x / this.baseDistance;
    }

    getSnapPoints() {
        return this._workspaceGroups.map(g =>
            this._getWorkspaceGroupProgress(g));
    }

    findClosestWorkspace(progress) {
        const distances = this.getSnapPoints().map(p =>
            Math.abs(p - progress));
        const index = distances.indexOf(Math.min(...distances));
        return this._workspaceGroups[index].workspace;
    }

    _interpolateProgress(progress, monitorGroup) {
        if (this.index === monitorGroup.index)
            return progress;

        const points1 = monitorGroup.getSnapPoints();
        const points2 = this.getSnapPoints();

        const upper = points1.indexOf(points1.find(p => p >= progress));
        const lower = points1.indexOf(points1.slice().reverse().find(p => p <= progress));

        if (points1[upper] === points1[lower])
            return points2[upper];

        const t = (progress - points1[lower]) / (points1[upper] - points1[lower]);

        return points2[lower] + (points2[upper] - points2[lower]) * t;
    }

    updateSwipeForMonitor(progress, monitorGroup) {
        this.progress = this._interpolateProgress(progress, monitorGroup);
    }
});

export class WorkspaceAnimationController {
    constructor() {
        this._movingWindow = null;
        this._switchData = null;

        Main.overview.connect('showing', () => {
            if (this._switchData) {
                if (this._switchData.gestureActivated)
                    this._finishWorkspaceSwitch(this._switchData);
                this._swipeTracker.enabled = false;
            }
        });
        Main.overview.connect('hiding', () => {
            this._swipeTracker.enabled = true;
        });

        const swipeTracker = new SwipeTracker.SwipeTracker(global.stage,
            Clutter.Orientation.HORIZONTAL,
            Shell.ActionMode.NORMAL,
            {allowDrag: false});
        swipeTracker.connect('begin', this._switchWorkspaceBegin.bind(this));
        swipeTracker.connect('update', this._switchWorkspaceUpdate.bind(this));
        swipeTracker.connect('end', this._switchWorkspaceEnd.bind(this));
        this._swipeTracker = swipeTracker;

        global.display.bind_property('compositor-modifiers',
            this._swipeTracker, 'scroll-modifiers',
            GObject.BindingFlags.SYNC_CREATE);
    }

    _prepareWorkspaceSwitch(workspaceIndices) {
        if (this._switchData)
            return;

        const workspaceManager = global.workspace_manager;
        const nWorkspaces = workspaceManager.get_n_workspaces();

        const switchData = {};

        this._switchData = switchData;
        switchData.monitors = [];

        switchData.gestureActivated = false;
        switchData.inProgress = false;

        if (!workspaceIndices)
            workspaceIndices = [...Array(nWorkspaces).keys()];

        const monitors = Meta.prefs_get_workspaces_only_on_primary()
            ? [Main.layoutManager.primaryMonitor] : Main.layoutManager.monitors;

        for (const monitor of monitors) {
            if (Meta.prefs_get_workspaces_only_on_primary() &&
                monitor.index !== Main.layoutManager.primaryIndex)
                continue;

            const group = new MonitorGroup(monitor, workspaceIndices, this.movingWindow);

            Main.uiGroup.insert_child_above(group, global.window_group);

            switchData.monitors.push(group);
        }

        Meta.disable_unredirect_for_display(global.display);
    }

    _finishWorkspaceSwitch(switchData) {
        Meta.enable_unredirect_for_display(global.display);

        this._switchData = null;

        switchData.monitors.forEach(m => m.destroy());

        this.movingWindow = null;
    }

    animateSwitch(from, to, direction, onComplete) {
        this._swipeTracker.enabled = false;

        let workspaceIndices = [];

        switch (direction) {
        case Meta.MotionDirection.UP:
        case Meta.MotionDirection.LEFT:
        case Meta.MotionDirection.UP_LEFT:
        case Meta.MotionDirection.UP_RIGHT:
            workspaceIndices = [to, from];
            break;

        case Meta.MotionDirection.DOWN:
        case Meta.MotionDirection.RIGHT:
        case Meta.MotionDirection.DOWN_LEFT:
        case Meta.MotionDirection.DOWN_RIGHT:
            workspaceIndices = [from, to];
            break;
        }

        if (Clutter.get_default_text_direction() === Clutter.TextDirection.RTL &&
            direction !== Meta.MotionDirection.UP &&
            direction !== Meta.MotionDirection.DOWN)
            workspaceIndices.reverse();

        this._prepareWorkspaceSwitch(workspaceIndices);
        const wasInProgress = this._switchData.inProgress;
        this._switchData.inProgress = true;

        const fromWs = global.workspace_manager.get_workspace_by_index(from);
        const toWs = global.workspace_manager.get_workspace_by_index(to);

        for (const monitorGroup of this._switchData.monitors) {
            if (wasInProgress) {
                monitorGroup.movingWindow = this._movingWindow;

                if (!monitorGroup.workspaceIndices.includes(from))
                    monitorGroup.addWorkspaceIndex(from);

                if (!monitorGroup.workspaceIndices.includes(to))
                    monitorGroup.addWorkspaceIndex(to);
            } else {
                monitorGroup.progress = monitorGroup.getWorkspaceProgress(fromWs);
            }

            const progress = monitorGroup.getWorkspaceProgress(toWs);

            const params = {
                duration: WINDOW_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            };

            if (wasInProgress) {
                const {progress: monitorGroupProgress} = monitorGroup;
                if (progress > monitorGroupProgress)
                    params.duration *= progress - monitorGroupProgress;
                else
                    params.duration *= monitorGroupProgress;
            }

            if (monitorGroup.index === Main.layoutManager.primaryIndex) {
                params.onComplete = () => {
                    this._finishWorkspaceSwitch(this._switchData);
                    onComplete();
                    this._swipeTracker.enabled = true;
                };
            }

            monitorGroup.ease_property('progress', progress, params);
        }
    }

    canHandleScrollEvent(event) {
        return this._swipeTracker.canHandleScrollEvent(event);
    }

    _findMonitorGroup(monitorIndex) {
        return this._switchData.monitors.find(m => m.index === monitorIndex);
    }

    _switchWorkspaceBegin(tracker, monitor) {
        if (Meta.prefs_get_workspaces_only_on_primary() &&
            monitor !== Main.layoutManager.primaryIndex)
            return;

        const workspaceManager = global.workspace_manager;
        const horiz = workspaceManager.layout_rows !== -1;
        tracker.orientation = horiz
            ? Clutter.Orientation.HORIZONTAL
            : Clutter.Orientation.VERTICAL;

        if (this._switchData && this._switchData.gestureActivated) {
            for (const group of this._switchData.monitors)
                group.remove_all_transitions();
        } else {
            this._prepareWorkspaceSwitch();
        }

        const monitorGroup = this._findMonitorGroup(monitor);
        const baseDistance = monitorGroup.baseDistance;
        const progress = monitorGroup.progress;

        const closestWs = monitorGroup.findClosestWorkspace(progress);
        const cancelProgress = monitorGroup.getWorkspaceProgress(closestWs);
        const points = monitorGroup.getSnapPoints();

        this._switchData.baseMonitorGroup = monitorGroup;

        tracker.confirmSwipe(baseDistance, points, progress, cancelProgress);
    }

    _switchWorkspaceUpdate(tracker, progress) {
        if (!this._switchData)
            return;

        for (const monitorGroup of this._switchData.monitors)
            monitorGroup.updateSwipeForMonitor(progress, this._switchData.baseMonitorGroup);
    }

    _switchWorkspaceEnd(tracker, duration, endProgress) {
        if (!this._switchData)
            return;

        const switchData = this._switchData;
        switchData.gestureActivated = true;

        const newWs = switchData.baseMonitorGroup.findClosestWorkspace(endProgress);
        const endTime = Clutter.get_current_event_time();

        for (const monitorGroup of this._switchData.monitors) {
            const progress = monitorGroup.getWorkspaceProgress(newWs);

            const params = {
                duration,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            };

            if (monitorGroup.index === Main.layoutManager.primaryIndex) {
                params.onComplete = () => {
                    if (!newWs.active)
                        newWs.activate(endTime);
                    this._finishWorkspaceSwitch(switchData);
                };
            }

            monitorGroup.ease_property('progress', progress, params);
        }
    }

    get gestureActive() {
        return this._switchData !== null && this._switchData.gestureActivated;
    }

    cancelSwitchAnimation() {
        if (!this._switchData)
            return;

        if (this._switchData.gestureActivated)
            return;

        this._finishWorkspaceSwitch(this._switchData);
    }

    set movingWindow(movingWindow) {
        this._movingWindow = movingWindow;
    }

    get movingWindow() {
        return this._movingWindow;
    }
}
