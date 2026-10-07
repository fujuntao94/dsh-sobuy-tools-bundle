import { join } from 'node:path'
import { componentDataDirectory } from 'sobuy-plugin-core/dsh-paths'
import { readOptionalJson, writePrivateJson } from 'sobuy-plugin-core/storage'

export function defaultDataDirectory() { return componentDataDirectory('customer-profile-tools') }
export function configPath(dataDirectory = defaultDataDirectory()) { return join(dataDirectory, 'sources.json') }
export async function readSourceConfig(dataDirectory = defaultDataDirectory()) { return readOptionalJson(configPath(dataDirectory)) }
export async function writeSourceConfig(value, dataDirectory = defaultDataDirectory()) { return writePrivateJson(configPath(dataDirectory), value) }
