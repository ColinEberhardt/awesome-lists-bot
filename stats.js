const ProgressBar = require('progress');
const program = require('commander');
const fs = require('fs');
const path = require('path');
const Q = require('q');
const GitHubApi = require('github');
const throat = require('throat');
const _ = require('underscore');

const packageConfig = fs.readFileSync(path.join(__dirname, 'package.json'));

program
  .version(JSON.parse(packageConfig).version)
  .option('-u, --username [string]', 'GitHub username')
  .option('-p, --password [string]', 'GitHub password or token')
  .option('-d, --debug', 'Outputs github API debug messages')
  .parse(process.argv);

if (!program.username || !program.password) {
  console.error('All parameters are mandatory');
  process.exit();
}

const merge = (promise, projection) => d =>
  promise(d)
    .then(projection)
    .then(result => Object.assign({}, d, result));

const github = new GitHubApi({
  version: '3.0.0',
  debug: program.debug
});
github.authenticate({
    type: 'token',
    token: program.password
});

const getRepoOwner = repoData =>
  Q.nfcall(github.repos.get, {
      user: program.username,
      repo: repoData.repoName,
    })
    .then(repoData => {
      return {
        owner: repoData.parent.owner.login,
        name: repoData.name
      };
    });

const getUpstreamPullRequests = repoData =>
  Q.nfcall(github.pullRequests.getAll, {
    user: repoData.owner,
    repo: repoData.name,
    state: 'all'
  })
  .then(d => d.filter(r => r.user.id === 18525563));

const getStatus = pr => {
  if (pr.closed_at && pr.merged_at) {
    return 'merged';
  } else if (pr.closed_at) {
    return 'closed';
  } else {
    return 'open';
  }
};

const getRepoCategory = repo => {
  if (repo.statuses['merged']) {
    return 'active';
  } else if (repo.statuses['open']) {
    return 'pending';
  } else if (Object.keys(repo.statuses).length === 0){
    return 'new';
  } else {
    return 'inactive';
  }
};

const getStatsForRepo = throat(2, repoData =>
  getRepoOwner({
      repoName: repoData.name
    })
    .then(merge(getUpstreamPullRequests, d => ({ pullRequests: d })))
    .then(d => ({
        statuses: _.countBy(d.pullRequests.map(getStatus), d => d),
        name: repoData.name,
        owner: d.owner,
        latest: d.pullRequests.length > 0 ? new Date(_.first(d.pullRequests).created_at) : undefined
      }))
);

Q.nfcall(github.repos.getAll, {})
  .then(repos => Q.all(repos.map(getStatsForRepo)))
  .then(repos => _.groupBy(repos, getRepoCategory))
  .then(d => console.log(JSON.stringify(d, null, 2)))
  .catch(console.error);
