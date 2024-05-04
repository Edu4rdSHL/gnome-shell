/* -*- Mode: C; indent-tabs-mode: nil; c-basic-offset: 8 -*- */

/*
 * This file is part of The Croco Library
 *
 * Copyright (C) 2002-2004 Dodji Seketeli
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of version 2.1 of the GNU Lesser General Public
 * License as published by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program; if not, write to the Free Software
 * Foundation, Inc., 59 Temple Place, Suite 330, Boston, MA 02111-1307
 * USA
 */

#include "string.h"
#include "cr-stylesheet.h"

/**
 *@file
 *The definition of the #CRStyleSheet class
 */

typedef struct {
        CRStyleSheet stylesheet;

        /**
         *the reference count of this instance of #CRStyleSheet.
         *It can be manipulated with cr_stylesheet_ref() and
         *cr_stylesheet_unref()
        */
        grefcount ref_count;

        /**
         *custom application data pointer
         *Can be used by applications.
         *libcroco itself will handle its destruction
         *if app_data_destroy_func is set via
         *cr_stylesheet_set_app_data().
         */
        gpointer app_data;
        GDestroyNotify app_data_destroy_func;
} CRStyleSheetReal;

/**
 *Constructor of the #CRStyleSheet class.
 *@param the initial list of css statements.
 *@return the newly built css2 stylesheet, or NULL in case of error.
 */
CRStyleSheet *
cr_stylesheet_new (CRStatement * a_stmts)
{
        CRStyleSheet *result;
        CRStyleSheetReal *real;

        result = g_try_malloc0 (sizeof (CRStyleSheetReal));
        if (!result) {
                cr_utils_trace_info ("Out of memory");
                return NULL;
        }

        real = (CRStyleSheetReal *) result;
        g_ref_count_init (&real->ref_count);

        if (a_stmts)
                result->statements = a_stmts;

        return result;
}

/**
 *@param a_this the current instance of #CRStyleSheet
 *@return the serialized stylesheet.
 */
gchar *
cr_stylesheet_to_string (CRStyleSheet const *a_this)
{
	gchar *str = NULL;
	GString *stringue = NULL;
	CRStatement const *cur_stmt = NULL;

        g_return_val_if_fail (a_this, NULL);

	if (a_this->statements) {
		stringue = g_string_new (NULL) ;
		g_return_val_if_fail (stringue, NULL) ;
	}
        for (cur_stmt = a_this->statements;
             cur_stmt; cur_stmt = cur_stmt->next) {
		if (cur_stmt->prev) {
			g_string_append (stringue, "\n\n") ;
		}
		str = cr_statement_to_string (cur_stmt, 0) ;
		if (str) {
			g_string_append (stringue, str) ;
			g_free (str) ;
			str = NULL ;
		}
        }
	if (stringue) {
		str = g_string_free (stringue, FALSE) ;
		stringue = NULL ;
	}
	return str ;
}

/**
 *Dumps the current css2 stylesheet to a file.
 *@param a_this the current instance of #CRStyleSheet.
 *@param a_fp the destination file
 */
void
cr_stylesheet_dump (CRStyleSheet const * a_this, FILE * a_fp)
{
	gchar *str = NULL ;

        g_return_if_fail (a_this);

	str = cr_stylesheet_to_string (a_this) ;
	if (str) {
		fprintf (a_fp, "%s", str) ;
		g_free (str) ;
		str = NULL ;
	}
}

/**
 *Return the number of rules in the stylesheet.
 *@param a_this the current instance of #CRStyleSheet.
 *@return number of rules in the stylesheet.
 */
gint
cr_stylesheet_nr_rules (CRStyleSheet const * a_this)
{
        g_return_val_if_fail (a_this, -1);

        return cr_statement_nr_rules (a_this->statements);
}

/**
 *Use an index to get a CRStatement from the rules in a given stylesheet.
 *@param a_this the current instance of #CRStatement.
 *@param itemnr the index into the rules.
 *@return CRStatement at position itemnr, if itemnr > number of rules - 1,
 *it will return NULL.
 */
CRStatement *
cr_stylesheet_statement_get_from_list (CRStyleSheet * a_this, int itemnr)
{
        g_return_val_if_fail (a_this, NULL);

        return cr_statement_get_from_list (a_this->statements, itemnr);
}

CRStyleSheet *
cr_stylesheet_ref (CRStyleSheet * a_this)
{
        CRStyleSheetReal *real = (CRStyleSheetReal *) a_this;

        g_return_val_if_fail (a_this, NULL);

        g_ref_count_inc (&real->ref_count);

        return a_this;
}

gboolean
cr_stylesheet_unref (CRStyleSheet * a_this)
{
        CRStyleSheetReal *real = (CRStyleSheetReal *) a_this;

        if (g_ref_count_dec (&real->ref_count)) {
                cr_stylesheet_destroy (a_this);
                return TRUE;
        }

        return FALSE;
}

static void
cleanup_app_data (CRStyleSheetReal * real)
{
        if (real->app_data_destroy_func) {
                g_clear_pointer (&real->app_data, real->app_data_destroy_func);
                real->app_data_destroy_func = NULL;
        }
}

/**
 *Destructor of the #CRStyleSheet class.
 *@param a_this the current instance of the #CRStyleSheet class.
 */
void
cr_stylesheet_destroy (CRStyleSheet * a_this)
{
        CRStyleSheetReal *real = (CRStyleSheetReal *) a_this;

        g_return_if_fail (a_this);

        if (a_this->statements) {
                cr_statement_destroy (a_this->statements);
                a_this->statements = NULL;
        }

        cleanup_app_data (real);
        g_free (a_this);
}

void
cr_stylesheet_set_app_data (CRStyleSheet   * a_this,
                            gpointer         app_data,
                            GDestroyNotify   app_data_destroy_func)
{
        CRStyleSheetReal *real = (CRStyleSheetReal *) a_this;

        g_return_if_fail (a_this);

        cleanup_app_data (real);

        real->app_data = app_data;
        real->app_data_destroy_func = app_data_destroy_func;
}

gpointer
cr_stylesheet_get_app_data (CRStyleSheet *a_this)
{
        CRStyleSheetReal *real = (CRStyleSheetReal *) a_this;

        g_return_val_if_fail (a_this, NULL);

        return real->app_data;
}
