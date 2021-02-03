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
        let cancelled;
        super((resolve, reject) => {
            rejector = reject;
            if (cancellable && cancellable.is_cancelled()) {
                cancelled = true;
                reject(new GLib.Error(Gio.IOErrorEnum,
                    Gio.IOErrorEnum.CANCELLED, 'Promise cancelled'));
            } else {
                executor(resolve, reject);
            }
        });

        this._cancelled = cancelled;
        this._rejector = rejector;

        if (cancellable) {
            this._cancellable = cancellable;
            this._cancellable.connect(() => this.cancel());
        }
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
            ret._root = this._root ? this._root : this;

        return ret;
    }

    resolved() {
        return !this.cancelled() && !!(this._root ? this._root : this)._resolved;
    }

    cancelled() {
        return !!(this._root ? this._root : this)._cancelled;
    }

    pending() {
        return !this.resolved() && !this.cancelled();
    }

    cancel() {
        if (this._root) {
            this._root.cancel();
            return this;
        }

        if (!this._rejector)
            throw new GObject.NotImplementedError();

        if (this._cancellable)
            this._cancellable.cancel();

        this._cancelled = !this._resolved;
        this._rejector(new GLib.Error(Gio.IOErrorEnum,
            Gio.IOErrorEnum.CANCELLED, 'Promise cancelled'));

        return this;
    }
};
