const ProgressBar = require('progress');
const awesomeStars = require('awesome-stars');
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
  .parse(process.argv);

if (!program.username || !program.password) {
  console.error('All parameters are mandatory');
  process.exit();
}

const sideEffect = side => d => {
  side(d)
  return d;
};

const rejectIfTrue = (fn, msg) => d => {
  if (fn(d)) {
    return Promise.reject(msg)
  } else {
    return d;
  }
}

const github = new GitHubApi({
  version: '3.0.0'
});
github.authenticate({
    type: 'token',
    token: program.password
});

const updateRepoReadme = (repoName) => {

  const getReadmeForRepo = () => {
    return Q.nfcall(github.repos.getContent, {
        user: program.username,
        repo: repoName,
        path: 'README.md'
      })
      .then(sideEffect(d => console.log('Fetched README for repo ' + repoName)))
      .then(res => {
        return {
          content: new Buffer(res.content, 'base64').toString('utf8'),
          sha: res.sha
        };
      });
  };

  const writeReadmeToRepo = (updatedMarkdown) =>
    Q.nfcall(github.repos.updateFile, {
        user: program.username,
        repo: repoName,
        path: 'README.md',
        message: 'Updated stars and redirects via awesome-stars-bot',
        sha: updatedMarkdown.sha,
        content: new Buffer(updatedMarkdown.updatedContent).toString('base64')
      })
      .then(sideEffect(d => console.log('Written README for repo ' + repoName)));

  const createPullRequest = () =>
    Q.nfcall(github.repos.get, {
        user: program.username,
        repo: repoName,
      })
      .then(repoData => repoData.parent.owner.login)
      .then(sideEffect(d => console.log('Creating PR against upstream repo ' + d)))
      .then(upstreamUser => Q.nfcall(github.pullRequests.create, {
        user: upstreamUser,
        repo: repoName,
        title: 'Updated stars and redirects via awesome-stars-bot',
        body: prBody,
        base: 'master',
        head: program.username + ':master'
      }));

  const addAwesomeStars = (markdown) => {
    var bar;
    return awesomeStars(markdown.content, program.username, program.password,
      (count) => {
        if (count) {
          bar = new ProgressBar('Fetching stars: [:bar] :percent', { total: count, width: 30 });
        } else {
          bar.tick();
        }
      })
      .then((updatedMarkdown) => Object.assign(markdown, { updatedContent: updatedMarkdown }));
  };

  return getReadmeForRepo()
    .then(addAwesomeStars)
    .then(sideEffect(d => console.log('checking for differences')))
    .then(rejectIfTrue(d => d.content === d.updatedContent, 'markdown has not changed'))
    .then(markdown => writeReadmeToRepo(markdown));
    .then(() => createPullRequest())
};

const reportRateLimit = () => {
  return Q.nfcall(github.misc.rateLimit, {})
    .then(d => d.resources.core.remaining)
    .then(sideEffect(d => console.log('Rate limit remaining', d)));
}


Q.nfcall(github.repos.getAll, {})
  .then(sideEffect(d => console.log('Fetched ' + d.length + ' repos')))
  .then(repos => _.sortBy(repos, repo => Date.parse(repo.updated_at)))
  .then(repos => _.last(repos).name)
  .then(sideEffect(d => console.log('Updating ' + d)))
  .then(updateRepoReadme)
  .catch(console.error)
  .finally(reportRateLimit)
