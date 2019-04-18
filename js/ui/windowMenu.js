// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*

const { GLib, GObject, Meta, St } = imports.gi;

const BoxPointer = imports.ui.boxpointer;
const Main = imports.ui.main;
const PopupMenu = imports.ui.popupMenu;

var WindowMenu = GObject.registerClass(
class WindowMenu extends PopupMenu.PopupMenu {
    _init(window, sourceActor) {
        super._init(sourceActor, 0, St.Side.TOP);

        this.add_style_class_name('window-menu');

        Main.layoutManager.uiGroup.add_actor(this);
        this.hide();

        this._buildMenu(window);
    }

    _buildMenu(window) {
        let type = window.get_window_type();

        let item;

        item = this.addAction(_("Minimize"), () => {
            window.minimize();
        });
        if (!window.can_minimize())
            item.setSensitive(false);

        if (window.get_maximized()) {
            item = this.addAction(_("Unmaximize"), () => {
                window.unmaximize(Meta.MaximizeFlags.BOTH);
            });
        } else {
            item = this.addAction(_("Maximize"), () => {
                window.maximize(Meta.MaximizeFlags.BOTH);
            });
        }
        if (!window.can_maximize())
            item.setSensitive(false);

        item = this.addAction(_("Move"), event => {
            this._grabAction(window, Meta.GrabOp.KEYBOARD_MOVING, event.get_time());
        });
        if (!window.allows_move())
            item.setSensitive(false);

        item = this.addAction(_("Resize"), event => {
            this._grabAction(window, Meta.GrabOp.KEYBOARD_RESIZING_UNKNOWN, event.get_time());
        });
        if (!window.allows_resize())
            item.setSensitive(false);

        if (!window.titlebar_is_onscreen() && type != Meta.WindowType.DOCK && type != Meta.WindowType.DESKTOP) {
            this.addAction(_("Move Titlebar Onscreen"), () => {
                window.shove_titlebar_onscreen();
            });
        }

        item = this.addAction(_("Always on Top"), () => {
            if (window.is_above())
                window.unmake_above();
            else
                window.make_above();
        });
        if (window.is_above())
            item.setOrnament(PopupMenu.Ornament.CHECK);
        if (window.get_maximized() == Meta.MaximizeFlags.BOTH ||
            type == Meta.WindowType.DOCK ||
            type == Meta.WindowType.DESKTOP ||
            type == Meta.WindowType.SPLASHSCREEN)
            item.setSensitive(false);

        if (Main.sessionMode.hasWorkspaces &&
            (!Meta.prefs_get_workspaces_only_on_primary() ||
             window.is_on_primary_monitor())) {
            let isSticky = window.is_on_all_workspaces();

            item = this.addAction(_("Always on Visible Workspace"), () => {
                if (isSticky)
                    window.unstick();
                else
                    window.stick();
            });
            if (isSticky)
                item.setOrnament(PopupMenu.Ornament.CHECK);
            if (window.is_always_on_all_workspaces())
                item.setSensitive(false);

            if (!isSticky) {
                let workspace = window.get_workspace();
                if (workspace != workspace.get_neighbor(Meta.MotionDirection.LEFT)) {
                    this.addAction(_("Move to Workspace Left"), () => {
                        let dir = Meta.MotionDirection.LEFT;
                        window.change_workspace(workspace.get_neighbor(dir));
                    });
                }
                if (workspace != workspace.get_neighbor(Meta.MotionDirection.RIGHT)) {
                    this.addAction(_("Move to Workspace Right"), () => {
                        let dir = Meta.MotionDirection.RIGHT;
                        window.change_workspace(workspace.get_neighbor(dir));
                    });
                }
                if (workspace != workspace.get_neighbor(Meta.MotionDirection.UP)) {
                    this.addAction(_("Move to Workspace Up"), () => {
                        let dir = Meta.MotionDirection.UP;
                        window.change_workspace(workspace.get_neighbor(dir));
                    });
                }
                if (workspace != workspace.get_neighbor(Meta.MotionDirection.DOWN)) {
                    this.addAction(_("Move to Workspace Down"), () => {
                        let dir = Meta.MotionDirection.DOWN;
                        window.change_workspace(workspace.get_neighbor(dir));
                    });
                }
            }
        }

        let display = global.display;
        let nMonitors = display.get_n_monitors();
        let monitorIndex = window.get_monitor();
        if (nMonitors > 1 && monitorIndex >= 0) {
            this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            let dir = Meta.DisplayDirection.UP;
            let upMonitorIndex =
                display.get_monitor_neighbor_index(monitorIndex, dir);
            if (upMonitorIndex != -1) {
                this.addAction(_("Move to Monitor Up"), () => {
                    window.move_to_monitor(upMonitorIndex);
                });
            }

            dir = Meta.DisplayDirection.DOWN;
            let downMonitorIndex =
                display.get_monitor_neighbor_index(monitorIndex, dir);
            if (downMonitorIndex != -1) {
                this.addAction(_("Move to Monitor Down"), () => {
                    window.move_to_monitor(downMonitorIndex);
                });
            }

            dir = Meta.DisplayDirection.LEFT;
            let leftMonitorIndex =
                display.get_monitor_neighbor_index(monitorIndex, dir);
            if (leftMonitorIndex != -1) {
                this.addAction(_("Move to Monitor Left"), () => {
                    window.move_to_monitor(leftMonitorIndex);
                });
            }

            dir = Meta.DisplayDirection.RIGHT;
            let rightMonitorIndex =
                display.get_monitor_neighbor_index(monitorIndex, dir);
            if (rightMonitorIndex != -1) {
                this.addAction(_("Move to Monitor Right"), () => {
                    window.move_to_monitor(rightMonitorIndex);
                });
            }
        }

        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        item = this.addAction(_("Close"), event => {
            window.delete(event.get_time());
        });
        if (!window.can_close())
            item.setSensitive(false);
    }
<<<<<<< HEAD

    _grabAction(window, grabOp, time) {
        if (global.display.get_grab_op() == Meta.GrabOp.NONE) {
            window.begin_grab_op(grabOp, true, time);
            return;
        }

        let waitId = 0;
        let id = global.display.connect('grab-op-end', (display) => {
            display.disconnect(id);
            GLib.source_remove(waitId);

            window.begin_grab_op(grabOp, true, time);
        });

        waitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            global.display.disconnect(id);
            return GLib.SOURCE_REMOVE;
        });
    }
};
=======
});
>>>>>>> popupMenu: Make menus St Widgets instead of containers

var WindowMenuManager = class {
    constructor() {
        this._manager = new PopupMenu.PopupMenuManager(Main.layoutManager.dummyCursor);

        this._sourceActor = new St.Widget({ reactive: true, visible: false });
        this._sourceActor.connect('button-press-event', () => {
            this._manager.activeMenu.toggle();
        });
        Main.uiGroup.add_actor(this._sourceActor);
    }

    showWindowMenuForWindow(window, type, rect) {
        if (!Main.sessionMode.hasWmMenus)
            return;

        if (type != Meta.WindowMenuType.WM)
            throw new Error('Unsupported window menu type');
        let menu = new WindowMenu(window, this._sourceActor);

        this._manager.addMenu(menu);

        menu.connect('activate', () => {
            window.check_alive(global.get_current_time());
        });
        let destroyId = window.connect('unmanaged', () => {
            menu.close();
        });

        this._sourceActor.set_size(Math.max(1, rect.width), Math.max(1, rect.height));
        this._sourceActor.set_position(rect.x, rect.y);
        this._sourceActor.show();

        menu.open(BoxPointer.PopupAnimation.NONE);
        menu.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
        menu.connect('open-state-changed', (menu_, isOpen) => {
            if (isOpen)
                return;

            this._sourceActor.hide();
            menu.destroy();
            window.disconnect(destroyId);
        });
    }
};
