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

const COMMIT_TITLE = 'Fixed broken links via ' + program.username;

const sideEffect = fn => d => {
  fn(d)
  return d;
};

const rejectIfTrue = (fn, msg) => d => {
  if (fn(d)) {
    return Promise.reject(msg)
  } else {
    return d;
  }
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

const reportRateLimit = () => {
  return Q.nfcall(github.misc.rateLimit, {})
    .then(d => d.resources.core.remaining)
    .then(sideEffect(d => console.log('Rate limit remaining', d)));
}

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
      })
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
    })
  });

const pickRepo = (repos) => {
  if (program.repo) {
    return program.repo;
  } else {
    const dateSort = _.sortBy(repos, repo => Date.parse(repo.updated_at));
    return _.last(repos).name;
  }
}

Q.nfcall(github.repos.getAll, {})
  // fetch all the repos that this bot operates on and select one to update
  .then(sideEffect(d => console.log('Fetched ' + d.length + ' repos')))
  .then(repos => { return { repoName: pickRepo(repos) }; })
  .then(sideEffect(d => console.log('Updating ' + d.repoName)))
  // get the owner, for the purposes of PRs etc ...
  .then(merge(getRepoOwner, d => { return {repoOwner: d}; }))
  // check if the bot already has a pending PR
  .then(merge(getUpstreamPullRequests, d => { return {upstreamPRs: d}; }))
  .then(rejectIfTrue(d => d.upstreamPRs.some(pr => pr.user.login === program.username), 'There is already a PR pending - Aborting!'))
  // update the bot's fork
  .then(merge(updateToUpstream, d => d))
  // get the README and update
  .then(merge(getReadmeForRepo, d => { return {path: d.path, content: d.content, original: d.content, sha: d.sha}; }))
  .then(merge(addAwesomeStars, d => { return {content: d}; }))
  .then(merge(checkLinks, d => { return {content: d.content, report: d.report}; }))
  // check if this has resulted in changes
  .then(sideEffect(d => console.log('Checking for differences')))
  .then(rejectIfTrue(d => d.original === d.content, 'Markdown has not changed - Aborting!'))
  // write the changes
  .then(merge(writeReadmeToRepo, d => d))
  .then(sideEffect(d => console.log('Written README for repo ' + d.repoName)))
  // create the PR
  .then(rejectIfTrue(() => program.test, 'Test mode, PR not being submitted'))
  .then(merge(createPullRequest, d => d))
  .then(sideEffect(d => console.log('PR submitted - all done :-)')))
  .catch(console.error)
  .finally(reportRateLimit);
