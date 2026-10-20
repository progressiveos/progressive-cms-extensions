// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

test('tagged supplies preserve bytes and executable modes across histories and umasks', t => {
  const root=mkdtempSync(join(tmpdir(),'pcms-pack-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const archives=[];
  for(const [name,date] of [['private','2026-01-01T00:00:00Z'],['public','2026-10-20T00:00:00Z']]) {
    const cwd=join(root,name);mkdirSync(join(cwd,'packages/example'),{recursive:true});
    copyFileSync(new URL('../pack.sh',import.meta.url),join(cwd,'pack.sh'));
    writeFileSync(join(cwd,'packages/example/manifest.json'),'{}\n');
    writeFileSync(join(cwd,'packages/example/run.sh'),'#!/bin/sh\nexit 0\n',{mode:0o755});
    const git=(...args)=>execFileSync('git',args,{cwd,env:{...process.env,GIT_AUTHOR_DATE:date,GIT_COMMITTER_DATE:date},stdio:'pipe'});
    git('init','-b','main');git('config','user.name','Example Maintainer');git('config','user.email','maintainer@example.test');
    git('add','packages');git('update-index','--chmod=+x','packages/example/run.sh');
    git('commit','-m',`Independent ${name} history`);git('tag','example-v1.0.0');
    git('config','tar.umask','0077');
    writeFileSync(join(cwd,'packages/example/secret.env'),'must not enter the archive');
    for(const mask of ['0002','0022','0077']) {
      execFileSync('sh',['-c',`umask ${mask}; sh pack.sh example-v1.0.0`],{cwd,stdio:'pipe'});
      const archive=join(cwd,'dist/example-1.0.0.tar.gz');
      assert.equal(execFileSync('tar',['-tzf',archive],{encoding:'utf8'}).includes('secret.env'),false);
      const modes=execFileSync('tar',['-tvzf',archive],{encoding:'utf8'});
      assert.match(modes,/-rwxrwxr-x.*packages\/example\/run.sh/);
      assert.match(modes,/-rw-rw-r--.*packages\/example\/manifest.json/);
      archives.push(readFileSync(archive));
    }
  }
  for(const archive of archives) assert.deepEqual(archives[0],archive);
});
