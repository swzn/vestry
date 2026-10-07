// Isolate every test from the developer's git configuration (system autocrlf, global identity, hooks...).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vestry-test-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.XDG_CONFIG_HOME = home;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = 'Test Author';
process.env.GIT_AUTHOR_EMAIL = 'author@example.com';
process.env.GIT_COMMITTER_NAME = 'Test Author';
process.env.GIT_COMMITTER_EMAIL = 'author@example.com';
delete process.env.GIT_DIR;
delete process.env.GIT_WORK_TREE;
delete process.env.GIT_INDEX_FILE;
delete process.env.VESTRY_SESSION;
delete process.env.VESTRY_STRICT;
