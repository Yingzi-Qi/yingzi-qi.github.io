import { json } from '../_lib/http.js';
import { status } from '../_lib/quota.js';
export const onRequestGet = async ({ env }) => json(await status(env));
