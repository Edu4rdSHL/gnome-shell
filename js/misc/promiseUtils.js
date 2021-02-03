// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported CancellablePromise */

const { Gio, GLib, GObject } = imports.gi;

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
