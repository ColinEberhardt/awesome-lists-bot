const ProgressBar = require('progress');
const awesomeStars = require('awesome-stars');
const awesomeLinks = require('awesome-link-checker');
const program = require('commander');
const fs = require('fs');
const path = require('path');
const Q = require('q');
const GitHubApi = require('github');
const _ = require('underscore');

const packageConfig = fs.readFileSync(path.join(__dirname, 'package.json'));
const prBody = fs.readFileSync(path.join(__dirname, 'pr-template.txt'), 'utf8');

program
  .version(JSON.parse(packageConfig).version)
  .option('-u, --username [string]', 'GitHub username')
  .option('-p, --password [string]', 'GitHub password or token')
  .option('-d, --debug', 'Outputs github API debug messages')
  .option('-t, --test', 'Test mode - does not produce pull requests')
  .option('-b, --bold [starCount]', 'Embolden links if the star count exceeds the given number')
  .option('-r, --repo [string]', 'Specify a repo to run the awesome bot against')
  .parse(process.argv);

if (!program.username || !program.password) {
  console.error('All parameters are mandatory');
  process.exit();
}

const COMMIT_TITLE = 'Added stars and fixed broken links via ' + program.username;

const sideEffect = fn => d => {
  fn(d)
  return d;
};

const rejectIfTrue = (fn, msg) => d => {
  if (fn(d)) {
    return Promise.reject(msg);
  } else {
    return d;
  }
};

const identity = d => d;

const merge = (promise, outTrans = identity, inTrans = identity) => d =>
  promise(inTrans(d))
    .then(outTrans)
    .then(result => Object.assign({}, d, result));

const github = new GitHubApi({
  version: '3.0.0',
  debug: program.debug
});
github.authenticate({
  type: 'token',
  token: program.password
});

const reportRateLimit = () => {
  return Q.nfcall(github.misc.rateLimit, {})
    .then(d => d.resources.core.remaining)
    .then(sideEffect(d => console.log('Rate limit remaining', d)));
};

const getRepoOwner = repoData =>
  Q.nfcall(github.repos.get, {
      user: program.username,
      repo: repoData.repoName,
    })
    .then(repoData => repoData.parent.owner.login);

const getReadmeForRepo = repoData => {
  return Q.nfcall(github.repos.getReadme, {
      user: program.username,
      repo: repoData.repoName
    })
    .then(sideEffect(d => console.log('Fetched README for repo ' + repoData.repoName)))
    .then(res => {
      return {
        content: new Buffer(res.content, 'base64').toString('utf8'),
        sha: res.sha,
        path: res.path
      };
    });
  };

const addAwesomeStars = (repoData) => {
    var bar;
    const config = {
      username: program.username,
      password: program.password,
      emboldenCount: program.bold || 0,
      progress: (count) => {
        if (count) {
          bar = new ProgressBar('Fetching stars: [:bar] :percent', { total: count, width: 30 });
        } else {
          bar.tick();
        }
      }
    };
    return awesomeStars(repoData.content, config);
  };

const checkLinks = (repoData) => {
    var bar;
    return awesomeLinks(repoData.content,
      (count) => {
        if (count) {
          bar = new ProgressBar('Checking links: [:bar] :percent', { total: count, width: 30 });
        } else {
          bar.tick();
        }
      });
  };

const writeReadmeToRepo = (repoData) =>
  Q.nfcall(github.repos.updateFile, {
      user: program.username,
      repo: repoData.repoName,
      path: repoData.path,
      message: COMMIT_TITLE + '\r\n\r\n' + repoData.report,
      sha: repoData.sha,
      content: new Buffer(repoData.content).toString('base64')
    });

const createPullRequest = (repoData) =>
  Q.nfcall(github.pullRequests.create, {
    user: repoData.repoOwner,
    repo: repoData.repoName,
    title: COMMIT_TITLE,
    body: prBody + '\r\n\r\n' + repoData.report,
    base: 'master',
    head: program.username + ':master'
  });

const getUpstreamPullRequests = (repoData) =>
  Q.nfcall(github.pullRequests.getAll, {
    user: repoData.repoOwner,
    repo: repoData.repoName
  });

const updateToUpstream = (repoData) =>
  Q.nfcall(github.gitdata.getReference, {
    user: repoData.repoOwner,
    repo: repoData.repoName,
    ref: 'heads/master'
  })
  .then(refData => {
    return Q.nfcall(github.gitdata.updateReference, {
      user: program.username,
      repo: repoData.repoName,
      ref: 'heads/master',
      sha: refData.object.sha,
      force: true
    });
  });

const pickRepo = (repos) => {
  if (program.repo) {
    return program.repo;
  } else {
    const dateSort = _.sortBy(repos, repo => Date.parse(repo.updated_at));
    return _.last(repos).name;
  }
};

const chainPromises = (initial, promises) =>
    promises.reduce(Q.when, Q(initial));

chainPromises(Q.nfcall(github.repos.getAll, {}), [
  // fetch all the repos that this bot operates on and select one to update
  sideEffect(d => console.log('Fetched ' + d.length + ' repos')),
  repos => ({ repoName: pickRepo(repos) }),
  sideEffect(d => console.log('Updating ' + d.repoName)),
  // get the owner, for the purposes of PRs etc ...
  merge(getRepoOwner, d => ({repoOwner: d})),
  // check if the bot already has a pending PR
  merge(getUpstreamPullRequests, d => ({upstreamPRs: d})),
  rejectIfTrue(d => d.upstreamPRs.some(pr => pr.user.login === program.username), 'There is already a PR pending - Aborting!'),
  // update the bot's fork
  merge(updateToUpstream),
  // get the README and update
  merge(getReadmeForRepo, d => ({path: d.path, content: d.content, original: d.content, sha: d.sha})),
  merge(addAwesomeStars, d => ({content: d})),
  merge(checkLinks, d => ({content: d.content, report: d.report})),
  // check if this has resulted in changes
  sideEffect(d => console.log('Checking for differences')),
  rejectIfTrue(d => d.original === d.content, 'Markdown has not changed - Aborting!'),
  sideEffect(d => { if (program.test) { console.log(d.content); } }),
  rejectIfTrue(() => program.test, 'Test mode, PR not being submitted'),
  // write the changes
  merge(writeReadmeToRepo),
  sideEffect(d => console.log('Written README for repo ' + d.repoName)),
  // create the PR
  merge(createPullRequest),
  sideEffect(d => console.log('PR submitted - all done :-)'))
])
.catch(console.error)
.finally(reportRateLimit);
