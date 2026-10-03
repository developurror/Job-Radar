/** Phase 3 API: flag settings (spec F7). Detection runs inside the scoring
 * endpoints; this module only exposes the enable/disable configuration. */
import type { Express } from 'express';
import type { Database } from '../db.js';
import { listFlagSettings, setFlagSetting } from './store.js';
import { FLAG_LABELS, FLAG_TYPES, type FlagType } from './types.js';

export function registerFlagRoutes(app: Express, database: Database): void {
  /** Flag configuration: all types with their enabled state. */
  app.get('/v1/flags/config', (_req, res) => {
    const settings = listFlagSettings(database);
    res.json({
      flags: settings.map((setting) => ({
        type: setting.type,
        label: FLAG_LABELS[setting.type],
        enabled: setting.enabled,
      })),
    });
  });

  /** Enable or disable one flag type. */
  app.patch('/v1/flags/config', (req, res) => {
    const type = req.body?.type as FlagType | undefined;
    const enabled = req.body?.enabled;
    if (!type || !(FLAG_TYPES as readonly string[]).includes(type)) {
      res.status(400).json({ error: `type must be one of: ${FLAG_TYPES.join(', ')}` });
      return;
    }
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }
    setFlagSetting(database, type, enabled);
    res.json({ type, label: FLAG_LABELS[type], enabled });
  });
}
