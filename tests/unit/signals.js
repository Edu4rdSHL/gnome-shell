// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const {jsUnit: JsUnit} = imports;
const {testUtils: TestUtils} = imports.unit;
const {testCase} = TestUtils;
const {signals: Signals} = imports.misc;

const Environment = imports.ui.environment;

Environment.init();

testCase('EventEmitter simple connections', () => {
    let fooCalled = 0, barCalled = 0;
    const emitter = new Signals.EventEmitter();
    const idFoo = emitter.connect('foo', () => ++fooCalled);
    const idBar = emitter.connect('bar', () => ++barCalled);

    emitter.emit('foo');
    JsUnit.assertEquals(1, fooCalled);
    JsUnit.assertEquals(0, barCalled);

    emitter.disconnect(idBar);
    emitter.emit('bar');
    JsUnit.assertEquals(0, barCalled);

    emitter.disconnect(idFoo);
});

testCase('EventEmitter callbacks blocked', () => {
    let fooCalled = false, foo2Called = false;
    const emitter = new Signals.EventEmitter();

    emitter.connect('foo', () => {
        fooCalled = true;
        return true;
    });
    emitter.connect('foo', () => (foo2Called = true));

    emitter.emit('foo');

    JsUnit.assertTrue(fooCalled);
    JsUnit.assertFalse(foo2Called);
});

testCase('EventEmitter connections', () => {
    let fooCalled = 0, barCalled = 0;
    const emitter = new Signals.EventEmitter();
    emitter.disconnect(emitter.connect('foo', () => TestUtils.assertNotReached()));
    const idFoo = emitter.connect('foo', (self, ...args) => {
        JsUnit.assertEquals(self, emitter);
        TestUtils.assertArrayEquals(args, ['args', 5, null, emitter]);
        fooCalled++;
    });
    const idBar = emitter.connect('bar', () => ++barCalled);

    JsUnit.assertTrue(emitter.signalHandlerIsConnected(idFoo));
    JsUnit.assertTrue(emitter.signalHandlerIsConnected(idBar));

    emitter.emit('foo', 'args', 5, null, emitter);
    JsUnit.assertEquals(1, fooCalled);
    JsUnit.assertEquals(0, barCalled);

    emitter.disconnect(idBar);
    JsUnit.assertTrue(emitter.signalHandlerIsConnected(idFoo));
    JsUnit.assertFalse(emitter.signalHandlerIsConnected(idBar));

    emitter.emit('bar');
    JsUnit.assertEquals(0, barCalled);

    emitter.disconnect(idFoo);
    JsUnit.assertFalse(emitter.signalHandlerIsConnected(idFoo));
    JsUnit.assertFalse(emitter.signalHandlerIsConnected(idBar));
});
