// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/* exported testCase, assertNotReached, checkIsNotReachedError,
   assertRaisesError, assertArrayEquals */

const {jsUnit: JsUnit} = imports;

class NotReachedError extends Error {}

/**
 * Runs test cases
 *
 * @param {string} name - The name of the test case
 * @param {Function} test - The test function to execute
 */
function testCase(name, test) {
    print(`Running test ${name}`);
    test();
}

/**
 * Deeply compares two arrays for equality
 *
 * @param {Array} array1 - The array to compare
 * @param {Array} array2 - The array to compare
 */
function assertArrayEquals(array1, array2) {
    JsUnit.assertEquals(array1.length, array2.length);
    for (let j = 0; j < array1.length; j++)
        JsUnit.assertEquals(array1[j], array2[j]);
}

/**
 * Ensures this code is not reached, throwing an error in case.
 */
function assertNotReached() {
    const error = new NotReachedError('This must not be reached');
    throw error;
}

/**
 * Verifies that an error is not thrown by assertNotReached()
 *
 * @param {Error} error - An error to check
 */
function checkIsNotReachedError(error) {
    JsUnit.assertFalse(error instanceof NotReachedError);
}

/**
 * Check if the function call would raise an error, comparing the result
 *
 * @param {Function} func - The function to verify
 * @param {(Error|string)} [error] - An error or an error message to compare
 */
function assertRaisesError(func, error = undefined) {
    if (!(func instanceof Function))
        throw new Error('Argument must be a function');

    try {
        func();
        assertNotReached();
    } catch (e) {
        checkIsNotReachedError(e);

        if (error instanceof Error)
            JsUnit.assertEquals(error, e);
        else if (typeof error === 'string')
            JsUnit.assertTrue(e.message.includes(error));
    }
}
