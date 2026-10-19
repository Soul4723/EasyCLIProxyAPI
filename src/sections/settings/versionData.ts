import { getVersion } from '../../services/platform';
import { createSettingsRead } from '../../services/settingsData';

export const appVersionRead = createSettingsRead(getVersion);
