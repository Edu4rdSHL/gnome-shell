/*
 * Copyright 2021 Red Hat, Inc.
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms and conditions of the GNU Lesser General Public License,
 * version 2.1, as published by the Free Software Foundation.
 *
 * This program is distributed in the hope it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE.  See the GNU Lesser General Public License for
 * more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

#ifndef ST_CONTEXT_H
#define ST_CONTEXT_H

#include <clutter/clutter.h>

/**
 * st_get_clutter_context:
 *
 * Returns: (transfer none): The Clutter context instance
 */
ClutterContext * st_get_clutter_context (void);

/**
 * st_init: (skip)
 */
void st_init (ClutterContext *clutter_context);

#endif /* ST_CONTEXT_H */
