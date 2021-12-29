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

#include "config.h"

#include "st-context.h"

static ClutterContext *st_clutter_context = NULL;

void
st_init (ClutterContext *clutter_context)
{
  g_warn_if_fail (!st_clutter_context);
  st_clutter_context = clutter_context;
}

ClutterContext *
st_get_clutter_context (void)
{
  return st_clutter_context;
}
