// MyFreeCams Recorder v.3.0.1

'use strict';

var Promise = require('bluebird');
var fs = Promise.promisifyAll(require('fs'));
var mvAsync = Promise.promisify(require('mv'));
var mkdirp = require('mkdirp');
var moment = require('moment');
var colors = require('colors');
var yaml = require('js-yaml');
var path = require('path');
var childProcess = require('child_process');
var HttpDispatcher = require('httpdispatcher');
var dispatcher = new HttpDispatcher();
var http = require('http');
var mfc = require('MFCAuto');
var EOL = require('os').EOL;
var compression = require('compression');
var bhttp = require('bhttp');
var session = bhttp.session();

var useDefaultOptions = {};
var compress = compression(useDefaultOptions);
var noop = () => {};

var onlineModels = []; // the list of online models from myfreecams.com
var cachedModels = []; // "cached" copy of onlineModels (primarily for index.html)
var captureModels = []; // the list of currently capturing models

var config = yaml.safeLoad(fs.readFileSync('config.yml', 'utf8'));

config.captureDirectory = config.captureDirectory || 'C:/Videos/MFC';
config.completeDirectory = config.completeDirectory || 'C:/Videos/MFC';
config.modelScanInterval = config.modelScanInterval || 30;
config.createModelDirectory = config.createModelDirectory || false;
config.dateFormat = config.dateFormat || 'DDMMYYYY-HHmmss';
config.downloadProgram = config.downloadProgram || 'rtmp';
config.minFileSizeMb = config.minFileSizeMb || 0;
config.port = config.port || 8888;
config.proxyServer = config.proxyServer;
config.models = Array.isArray(config.models) ? config.models : [];
config.queue = Array.isArray(config.queue) ? config.queue : [];

var captureDirectory = path.resolve(config.captureDirectory);
var completeDirectory = path.resolve(config.completeDirectory);
var isDirty = false;
var minFileSize = config.minFileSizeMb * 1048576;

var mfcClient = new mfc.Client();

var ngvideoServers = {
  "1545": "545",
  "1546": "546",
  "1547": "547",
  "1548": "548",
  "1549": "549",
  "1550": "550",
  "1551": "551",
  "1552": "552",
  "1553": "553",
  "1554": "554"};

function getCurrentTime() {return moment().format('HH:mm:ss')};

function printMsg(msg) {console.log(colors.gray('[' + getCurrentTime() + ']'), msg);}

function printErrorMsg(msg) {console.log(colors.gray('[' + getCurrentTime() + ']'), colors.red('[ERROR]'), msg)}

function printDebugMsg(msg) {if (config.debug && msg) {console.log(colors.gray('[' + getCurrentTime() + ']'), colors.magenta('[DEBUG]'), msg)}}

function mkdir(dir) {mkdirp(dir, err => {if (err) {printErrorMsg(err);process.exit(1);}});}

function remove(value, array) {let idx = array.indexOf(value);

  if (idx !== -1) {array.splice(idx, 1);}}

function getProxyModels() {if (!config.proxyServer) {return []}

  return new Promise((resolve, reject) => {
    return Promise
      .try(() => session.get(`http://${config.proxyServer}/models?nc=${Date.now()}`))
      .timeout(10000) // 10 seconds
      .then(response => {
        resolve(response.body || []);
      })
      .catch(err => {
        printDebugMsg(err.toString());
        resolve([]);
      });
  });
}

function getOnlineModels(proxyModels) {
  let models = [];

  mfc.Model.knownModels.forEach(m => {
    if (m.bestSession.vs !== mfc.STATE.Offline && m.bestSession.camserv > 0 && !!m.bestSession.nm) {
      models.push({
        nm: m.bestSession.nm,
        sid: m.bestSession.sid,
        uid: m.bestSession.uid,
        vs: m.bestSession.vs,
        camserv: m.bestSession.camserv,
        topic: m.bestSession.topic,
        missmfc: m.bestSession.missmfc,
        new_model: m.bestSession.new_model,
        camscore: m.bestSession.camscore,
        continent: m.bestSession.continent,
        age: m.bestSession.age,
        city: m.bestSession.city,
        country: m.bestSession.country,
        blurb: m.bestSession.blurb,
        occupation: m.bestSession.occupation,
        ethnic: m.bestSession.ethnic,
        phase: m.bestSession.phase,
        rank: m.bestSession.rank,
        rc: m.bestSession.rc,
        tags: m.bestSession.tags
      });
    }
  });

  if (proxyModels.length > 0) {
    // remove models that available in the current region from proxyModels (foreign region)
    let newModels = proxyModels.filter(pm => !models.find(m => (m.uid === pm.uid)));

    printDebugMsg(`${newModels.length} new model(s) from proxy ${colors.green(config.proxyServer)}`);

    // merge newModels with "local" models
    onlineModels = models.concat(newModels);
  } else {onlineModels = models}

  printMsg(`${onlineModels.length} model(s) online.`)}

// goes through the models in the queue and updates their settings in config
function updateConfigModels() {printDebugMsg(`${config.queue.length} model(s) in the queue.`);

  config.queue = config.queue.filter(queueModel => {
    // if uid is not set then search uid of the model in the list of online models
    if (!queueModel.uid) {let onlineModel = onlineModels.find(m => (m.nm === queueModel.nm));

      // if we could not find the uid of the model we leave her in the queue and jump to the next queue model
      if (!onlineModel) {return true}

      queueModel.uid = onlineModel.uid;
    }

    // looking for the model in our config
    let configModel = config.models.find(m => (m.uid === queueModel.uid));

    if (!configModel) {
      // if we don't have the model in our config we add here in
      config.models.push({uid: queueModel.uid, mode: queueModel.mode});
    } else {configModel.mode = queueModel.mode}

    isDirty = true;

    // probably here we should remove duplicates from config

    return false;
  });
}

function selectModelsToCapture() {printDebugMsg(`${config.models.length} model(s) in config.`);

  let modelsToCapture = [];
  let now = moment().unix();

  config.models.forEach(configModel => {let onlineModel = onlineModels.find(m => (m.uid === configModel.uid));

    if (!onlineModel) { // skip the model if she is not online
      return;
    }

    // if the model has "expired" me mark her as "excluded"
    if (configModel.mode > 1 && configModel.mode < now) {
      printMsg(colors.green(onlineModel.nm) + ' expired.');

      configModel.mode = 0;

      isDirty = true;
    }

    onlineModel.mode = configModel.mode;

    if (configModel.mode < 1) { // skip the mode if she is "deleted" or "excluded"
      return;
    }

    // save the name of the model in config if it has not been set before
    if (!configModel.nm) {configModel.nm = onlineModel.nm;

      isDirty = true;
    }

    onlineModel.dir_nm = configModel.nm;

    if (onlineModel.vs === 0) {modelsToCapture.push(onlineModel);
    } else if (onlineModel.vs === 2) {printMsg(`${colors.green(onlineModel.nm)} is AWAY.`);
    } else if (onlineModel.vs === 12) {printMsg(`${colors.green(onlineModel.nm)} is PRIVATE.`);
    } else if (onlineModel.vs === 13) {printMsg(`${colors.green(onlineModel.nm)} is GROUP SHOW.`);
    } else if (onlineModel.vs === 91) {printMsg(`${colors.green(onlineModel.nm)} is PRIVATE.`)}});

  printDebugMsg(`${modelsToCapture.length} model(s) to recording.`);

  return modelsToCapture}

let fileFormat;
   if (config.downloadProgram == 'ls') {fileFormat = 'mp4'}
   if (config.downloadProgram == 'sl') {fileFormat = 'mp4'}
   if (config.downloadProgram == 'ff-ts') {fileFormat = 'ts'}
   if (config.downloadProgram == 'ff-flv') {fileFormat = 'flv'}
   if (config.downloadProgram == 'rtmp') {fileFormat = 'flv'}
   if (config.downloadProgram == 'hls') {fileFormat = 'mp4'}

function createMainCaptureProcess(model) {
  return Promise
    .try(() => {
      let filename = model.nm + '_MFC_' + moment().format(config.dateFormat) + '.' + fileFormat;
      let roomId = 100000000 + model.uid;

      let hlsUrl = (!ngvideoServers[model.camserv])
        ? `http://video${model.camserv - 500}.myfreecams.com:1935/NxServer/ngrp:mfc_${roomId}.f4v_mobile/playlist.m3u8?nc=${Date.now()}`
        : `https://video${ngvideoServers[model.camserv]}.myfreecams.com:8444/x-hls/${mfcClient.stream_cxid}/${roomId}/${mfcClient.stream_password}/${mfcClient.stream_vidctx}/mfc_${model.phase}_${roomId}.m3u8`;

      let captureProcess;
         if (config.downloadProgram == 'ls') {captureProcess = childProcess.spawn('livestreamer', ['-Q','hlsvariant://' + hlsUrl,'best','--stream-sorting-excludes=>950p,>1500k','-o',path.join(captureDirectory, filename)])}
         if (config.downloadProgram == 'sl') {captureProcess = childProcess.spawn('streamlink', ['-Q','hlsvariant://' + hlsUrl,'best','--stream-sorting-excludes=>950p,>1500k','-o',path.join(captureDirectory, filename)])}
         if (config.downloadProgram == 'ff-ts') {captureProcess = childProcess.spawn('ffmpeg', ['-hide_banner','-v','fatal','-i',hlsUrl,'-map','0:1','-map','0:2','-c','copy','-vsync','2','-r','60','-b:v','500k',path.join(captureDirectory, filename)])}
         if (config.downloadProgram == 'ff-flv') {captureProcess = childProcess.spawn('ffmpeg', ['-hide_banner','-v','fatal','-i',hlsUrl,'-c:v','copy','-map','0:1','-map','0:2','-c:a','aac','-b:a','192k','-ar','32000',path.join(captureDirectory, filename)])}
         if (config.downloadProgram == 'rtmp') {captureProcess = childProcess.spawn('mfcd', [model.nm,path.join(captureDirectory, filename)])}
         if (config.downloadProgram == 'hls') {captureProcess = childProcess.spawn('hlsdl', [hlsUrl,'-b','-q','-o',path.join(captureDirectory, filename)])}

      if (!captureProcess.pid) {
        return;
      }

      captureProcess.stdout.on('data', data => {printMsg(data.toString())});

      captureProcess.stderr.on('data', data => {printMsg(data.toString())});

      captureProcess.on('close', code => {
        printMsg(`${colors.green(model.nm)} stopped streaming.`);

        let stoppedModel = captureModels.find(m => m.captureProcess === captureProcess);

        remove(stoppedModel, captureModels);

        let src = path.join(captureDirectory, filename);
        let dst = config.createModelDirectory
          ? path.join(completeDirectory, model.dir_nm, filename)
          : path.join(completeDirectory, filename);

        fs.statAsync(src)
          // if the file is big enough we keep it otherwise we delete it
          .then(stats => (stats.size <= minFileSize) ? fs.unlinkAsync(src) : mvAsync(src, dst, { mkdirp: true }))
          .catch(err => {if (err.code !== 'ENOENT') {printErrorMsg('[' + colors.green(model.nm) + '] ' + err.toString())}})});

      captureModels.push({
        nm: model.nm,
        uid: model.uid,
        filename: filename,
        captureProcess: captureProcess,
        checkAfter: moment().unix() + 60, // we are gonna check this process after 1 min
        size: 0
      });
    })
    .catch(err => {printErrorMsg('[' + colors.green(model.nm) + '] ' + err.toString())})}

function createCaptureProcess(model) {if (model.camserv < 840) { // skip models without "mobile feed"
    return;
  }

  let captureModel = captureModels.find(m => (m.uid === model.uid));

  if (captureModel !== undefined) {printMsg(colors.yellow('>>> ' + captureModel.filename));

    return;
  }

  printMsg(colors.green(model.nm) + ' now online - starting recording process.');

  return createMainCaptureProcess(model);
}

function checkCaptureProcess(model) {var onlineModel = onlineModels.find(m => (m.uid === model.uid));

  if (onlineModel) {
    if (onlineModel.mode >= 1) {
      onlineModel.capturing = true;
    } else if (model.captureProcess) {
      // if the model was excluded or deleted we stop her "captureProcess"
      printDebugMsg(colors.green(model.nm) + ' has to be stopped.');

      model.captureProcess.kill();

      return;
    }
  }

  // if this is not the time to check the process and resolve immediately
  if (model.checkAfter > moment().unix()) {
    return;
  }

  return fs
    .statAsync(path.join(captureDirectory, model.filename))
    .then(stats => {
      // we check model's process every 10 minutes,
      // if the size of the file has not changed for the last 10 min, we kill this process
      if (stats.size > model.size) {
        printDebugMsg(colors.green(model.nm) + ' is alive.');

        model.checkAfter = moment().unix() + 300; // 5 minutes
        model.size = stats.size;
      } else if (model.captureProcess) {
        // we assume that onClose will do all the cleaning for us
        printErrorMsg('[' + colors.green(model.nm) + '] process is dead.');
        model.captureProcess.kill();
      } else {
        // probably we should forcefully remove the model from captureModels
        // because her captureProcess is unset, but let's leave it as is for now
        // remove(model, captureModels);
      }
    })
    .catch(err => {
      if (err.code === 'ENOENT') {
        // do nothing, file does not exists,
        // this is kind of impossible case, however, probably there should be some code to "clean up" the process
      } else {
        printErrorMsg('[' + colors.green(model.nm) + '] ' + err.toString())}})}

function saveConfig() {if (!isDirty) {return}

  // remove duplicates,
  // we should not have them, but just in case...
  config.models = config.models.filter((m, index, self) => (index === self.indexOf(m)));

  printDebugMsg('Save changes in config.yml');

  return fs
    .writeFileAsync('config.yml', yaml.safeDump(config), 'utf8')
    .then(() => {isDirty = false})}

function cacheModels() {cachedModels = onlineModels.filter(m => (m.mode !== -1))}

function mainLoop() {printDebugMsg('Start new cycle.');

  Promise
    .try(getProxyModels)
    .then(getOnlineModels)
    .then(updateConfigModels)
    .then(selectModelsToCapture)
    .then(modelsToCapture => Promise.all(modelsToCapture.map(createCaptureProcess)))
    .then(() => Promise.all(captureModels.map(checkCaptureProcess)))
    .then(saveConfig)
    .then(cacheModels)
    .catch(printErrorMsg)
    .finally(() => {printMsg(`Done, will search for new models in ${config.modelScanInterval} second(s).`);

     setTimeout(mainLoop, config.modelScanInterval * 1000)})}

mkdir(captureDirectory);
mkdir(completeDirectory);

Promise
  .try(() => mfcClient.connectAndWaitForModels())
  .timeout(120000) // if we could not get a list of online models in 2 minutes then exit
  .then(() => mainLoop())
  .catch(err => {
    printErrorMsg(err.toString());
    process.exit(1)});

function addInQueue(req, res) {
  let model;
  let mode = 0;

  if (req.url.startsWith('/models/include')) {mode = 1;

  if (req.params && req.params.expire_after) {let expireAfter = parseFloat(req.params.expire_after);

  if (!Number.isNaN(expireAfter) && expireAfter > 0) {mode = moment().unix() + (expireAfter * 3600)}}
  } else if (req.url.startsWith('/models/delete')) {mode = -1}

  if (req.params && req.params.uid) {let uid = parseInt(req.params.uid, 10);

  if (!Number.isNaN(uid)) {model = { uid: uid, mode: mode }}
  } else if (req.params && req.params.nm) {model = { nm: req.params.nm, mode: mode }}

  if (!model) {
    res.writeHead(422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request' }));
  } else {printDebugMsg(colors.green(model.uid || model.nm) + ' to ' + (mode >= 1 ? 'include.' : (mode === 0 ? 'exclude.' : 'delete.')));

    config.queue.push(model);

    var cachedModel = !model.uid
      ? cachedModels.find(m => (m.nm === model.nm))
      : cachedModels.find(m => (m.uid === model.uid));

    if (cachedModel) {cachedModel.nextMode = mode}

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(model))}} // this will be sent back to the browser

dispatcher.onGet('/', (req, res) => {
  fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('Not Found');
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data, 'utf-8');
    }
  });
});

dispatcher.onGet('/favicon.ico', (req, res) => {
  fs.readFile(path.join(__dirname, 'favicon.ico'), (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('Not Found');
    } else {
      res.writeHead(200, { 'Content-Type': 'image/x-icon' });
      res.end(data);
    }
  });
});

dispatcher.onGet('/models', (req, res) => {
  compress(req, res, noop);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(cachedModels));
});

// when we include the model we only "express our intention" to do so,
// in fact the model will be included in the config only with the next iteration of mainLoop
dispatcher.onGet('/models/include', addInQueue);

// whenever we exclude the model we only "express our intention" to do so,
// in fact the model will be exclude from config only with the next iteration of mainLoop
dispatcher.onGet('/models/exclude', addInQueue);

// whenever we delete the model we only "express our intention" to do so,
// in fact the model will be marked as "deleted" in config only with the next iteration of mainLoop
dispatcher.onGet('/models/delete', addInQueue);

http.createServer((req, res) => {
  dispatcher.dispatch(req, res);
}).listen(config.port, () => {
  printMsg('Server listening on: ' + colors.green('0.0.0.0:' + config.port));
});
