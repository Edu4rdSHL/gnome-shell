// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
/*
 * Copyright 2022 Red Hat, Inc
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program; if not, see <http://www.gnu.org/licenses/>.
 */

const fwupd = imports.fwupd.fwupd;

// eslint-disable-next-line
var FwupdChecker = class {
    constructor() {
        this._source = null;
        this._sbFlag = null;
        this._pkFLag = null;

        this.fwupdObj = new fwupd.Fwupd();
    }

    setLabel(loginDialog) {
        if ((this._sbFlag & 0x2) > 0) {
            loginDialog._securebootWarningLabel.set_text(_('Secure Boot is not Availiable.'));
            loginDialog._warningBoxLayout.visible = true;
        } else if ((this._pkFLag & 0x1) > 0 && (this._sbFlag & 0x1) > 0) {
            loginDialog._warningBoxLayout.visible = false;
        } else if ((this._sbFlag & 0x1) > 0) {
            loginDialog._warningBoxLayout.visible = true;
        } else {
            loginDialog._warningBoxLayout.visible = true;
        }
    }

    async test(loginDialog) {
        await this.fwupdObj.securebootCheckAndNotify();
        loginDialog._warningBoxLayout.visible = false;

        if (this.fwupdObj.isFwupdPresent) {
            this._pkFLag = this.fwupdObj.pkFLag;
            this._sbFlag = this.fwupdObj.sbFlag;
            this.setLabel(loginDialog);
        }
    }
};
