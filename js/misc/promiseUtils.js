// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported CancellablePromise, SignalConnectionPromiseFull,
   SignalConnectionPromise, IdlePromise, TimeoutPromise, TimeoutSecondsPromise,
   MetaLaterPromise */

const { Gio, GLib, GObject, Meta } = imports.gi;

var CancellablePromise = class extends Promise {
    constructor(executor, cancellable) {
        if (!(executor instanceof Function))
            throw TypeError('executor is not a function');

        if (cancellable && !(cancellable instanceof Gio.Cancellable))
            throw TypeError('cancellable parameter is not a Gio.Cancellable');

        let rejector;
        let resolver;
        super((resolve, reject) => {
            resolver = resolve;
            rejector = reject;
        });

        this._resolver = (...args) => {
            resolver(...args);
            this._resolved = true;
            this._cleanup();
        };
        this._rejector = (...args) => {
            rejector(...args);
            this._rejected = true;
            this._cleanup();
        };

        if (!cancellable) {
            executor(this._resolver, this._rejector);
            return;
        }

        this._cancellable = cancellable;
        this._cancelled = cancellable.is_cancelled();
        if (this._cancelled) {
            this._rejector(new GLib.Error(Gio.IOErrorEnum,
                Gio.IOErrorEnum.CANCELLED, 'Promise cancelled'));
            return;
        }

        this._cancellationId = cancellable.connect(() => {
            const id = this._cancellationId;
            this._cancellationId = 0;
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => cancellable.disconnect(id));
            this.cancel();
        });

        executor(this._resolver, this._rejector);
    }

    _cleanup() {
        if (this._cancellationId)
            this._cancellable.disconnect(this._cancellationId);
    }

    get cancellable() {
        return this._chainRoot._cancellable || null;
    }

    get _chainRoot() {
        return this._root ?? this;
    }

    then(...args) {
        const ret = super.then(...args);

        /* Every time we call then() on this promise we'd get a new
         * CancellablePromise however that won't have the properties that the
         * root one has set, and then it won't be possible to cancel a promise
         * chain from the last one.
         * To allow this we keep track of the root promise, make sure that
         * the same method on the root object is called during cancellation
         * or any destruction method if you want this to work. */
        if (ret instanceof CancellablePromise)
            ret._root = this._chainRoot;

        return ret;
    }

    resolved() {
        return !!this._chainRoot._resolved;
    }

    rejected() {
        return !!this._chainRoot._rejected;
    }

    cancelled() {
        return !!this._chainRoot._cancelled;
    }

    pending() {
        return !this.resolved() && !this.rejected();
    }

    cancel() {
        if (this._root) {
            this._root.cancel();
            return this;
        }

        if (!this.pending())
            return this;

        this._cancelled = true;
        this._rejector(new GLib.Error(Gio.IOErrorEnum,
            Gio.IOErrorEnum.CANCELLED, 'Promise cancelled'));

        return this;
    }
};

const SignalConnectionPromiseFlags = Object.freeze({
    NONE: 0,
    AFTER: 1 << 0,
    MULTIPLE: 1 << 1,
});

var SignalConnectionPromiseFull = class extends CancellablePromise {
    static get Flags() {
        return SignalConnectionPromiseFlags;
    }

    constructor(object, signal, handler, flags, cancellable) {
        if (arguments.length === 1 && arguments[0] instanceof Function) {
            super(object);
            return;
        }

        if (flags === undefined)
            flags = SignalConnectionPromiseFull.Flags.NONE;

        if (flags & SignalConnectionPromiseFull.Flags.AFTER) {
            if (!(object.connect_after instanceof Function))
                throw new TypeError('Not a valid object');
        } else if (!(object.connect instanceof Function)) {
            throw new TypeError('Not a valid object');
        }

        if (!(handler instanceof Function))
            throw new TypeError('Not a valid handler');

        if (object instanceof GObject.Object &&
            !GObject.signal_lookup(signal.split(':')[0], object.constructor.$gtype))
            throw new TypeError(`Signal ${signal} not found on object ${object}`);

        let id;
        let destroyId;
        super((resolve, reject) => {
            let connectSignal;
            if (object instanceof GObject.Object) {
                if (flags & SignalConnectionPromiseFull.Flags.AFTER)
                    connectSignal = (sig, cb) => GObject.signal_connect_after(object, sig, cb);
                else
                    connectSignal = (sig, cb) => GObject.signal_connect(object, sig, cb);
            } else if (flags & SignalConnectionPromiseFull.Flags.AFTER) {
                connectSignal = (sig, cb) => object.connect_after(sig, cb);
            } else {
                connectSignal = (sig, cb) => object.connect(sig, cb);
            }

            id = connectSignal(signal, (_obj, ...args) => {
                const promiseHandler = { resolve, reject };
                let ret;
                if (!args.length)
                    ret = handler(promiseHandler);
                else
                    ret = handler(promiseHandler, args.length === 1 ? args[0] : args);

                if (flags & SignalConnectionPromiseFull.Flags.MULTIPLE)
                    return ret;

                if (this.pending()) {
                    const e = new Error('Promise was not resolved or rejected');
                    reject(e);
                    throw e;
                }

                return ret;
            });

            if (signal !== 'destroy' &&
                (!(object instanceof GObject.Object) ||
                 GObject.signal_lookup('destroy', object.constructor.$gtype)))
                destroyId = connectSignal('destroy', () => this.cancel());
        }, cancellable);

        this._object = object;
        this._id = id;
        this._destroyId = destroyId;
    }

    _cleanup() {
        if (this._id) {
            let disconnectSignal;

            if (this._object instanceof GObject.Object)
                disconnectSignal = id => GObject.signal_handler_disconnect(this._object, id);
            else
                disconnectSignal = id => this._object.disconnect(id);

            disconnectSignal(this._id);
            if (this._destroyId) {
                disconnectSignal(this._destroyId);
                this._destroyId = 0;
            }
            this._object = null;
            this._id = 0;
        }

        super._cleanup();
    }

    get object() {
        return this._chainRoot._object;
    }
};

var SignalConnectionPromise = class extends SignalConnectionPromiseFull {
    constructor(object, signal, cancellable) {
        if (arguments.length === 1 && arguments[0] instanceof Function) {
            super(object);
            return;
        }

        super(object, signal, (promise, ...args) => promise.resolve(...args),
            SignalConnectionPromiseFull.Flags.NONE, cancellable);
    }
};

var GSourcePromise = class extends CancellablePromise {
    constructor(gsource, priority, cancellable) {
        if (arguments.length === 1 && arguments[0] instanceof Function) {
            super(gsource);
            return;
        }

        if (gsource.constructor.$gtype !== GLib.Source.$gtype)
            throw new TypeError(`gsource ${gsource} is not of type GLib.Source`);

        if (priority === undefined)
            priority = GLib.PRIORITY_DEFAULT;
        else if (!Number.isInteger(priority) && typeof priority !== 'bigint')
            throw TypeError('Invalid priority');

        super(resolve => {
            gsource.set_priority(priority);
            gsource.set_callback(() => {
                resolve();
                return GLib.SOURCE_REMOVE;
            });
            gsource.attach(null);
        }, cancellable);

        this._gsource = gsource;
        this._gsource.set_name(`[gnome-shell] ${this.constructor.name} ${
            new Error().stack.split('\n').filter(line =>
                !line.match(/misc\/promiseUtils\.js/))[0]}`);

        if (this.rejected())
            this._gsource.destroy();
    }

    get gsource() {
        return this._chainRoot._gsource;
    }

    _cleanup() {
        this._gsource?.destroy();
        this._gsource = null;
        super._cleanup();
    }
};

var IdlePromise = class extends GSourcePromise {
    constructor(priority, cancellable) {
        if (arguments.length === 1 && arguments[0] instanceof Function) {
            super(priority);
            return;
        }

        if (priority === undefined)
            priority = GLib.PRIORITY_DEFAULT_IDLE;

        super(GLib.idle_source_new(), priority, cancellable);
    }
};

var TimeoutPromise = class extends GSourcePromise {
    constructor(interval, priority, cancellable) {
        if (arguments.length === 1 && arguments[0] instanceof Function) {
            super(interval);
            return;
        }

        if ((!Number.isInteger(interval) && typeof interval !== 'bigint') ||
            interval < 0)
            throw TypeError('Invalid interval');

        super(GLib.timeout_source_new(interval), priority, cancellable);
    }
};

var TimeoutSecondsPromise = class extends GSourcePromise {
    constructor(interval, priority, cancellable) {
        if (arguments.length === 1 && arguments[0] instanceof Function) {
            super(interval);
            return;
        }

        if ((!Number.isInteger(interval) && typeof interval !== 'bigint') ||
            interval < 0)
            throw TypeError('Invalid interval');

        super(GLib.timeout_source_new_seconds(interval), priority, cancellable);
    }
};

var MetaLaterPromise = class extends CancellablePromise {
    constructor(laterType, cancellable) {
        if (arguments.length === 1 && arguments[0] instanceof Function) {
            super(laterType);
            return;
        }

        if (laterType && laterType.constructor.$gtype !== Meta.LaterType.$gtype)
            throw new TypeError(`laterType ${laterType} is not of type Meta.LaterType`);
        else if (!laterType)
            laterType = Meta.LaterType.BEFORE_REDRAW;

        let id;
        super(resolve => {
            id = Meta.later_add(laterType, () => {
                this.remove();
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        }, cancellable);

        this._id = id;
    }

    _cleanup() {
        if (this._id) {
            Meta.later_remove(this._id);
            this._id = 0;
        }
        super._cleanup();
    }
};
