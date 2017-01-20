const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const rp = require('request-promise-native');
const cheerio = require('cheerio');
const yauzl = require('yauzl');
const mkdirp = require('mkdirp');
const chalk = require('chalk');
const humanizeDuration = require('humanize-duration');

const enqueue = require('./lib/enqueue');

const config = {
  indexUrl: process.env.SCRAPER_INDEX_URL || 'http://gis.epa.ie/GetData/Download',
  downloadUrl: process.env.SCRAPER_DOWNLOAD_URL || 'http://gis.epa.ie/getdata/downloaddata',
  mailbackMailbox: process.env.SCRAPER_MAILBACK_MAILBOX,
  maxDocs: parseInt(process.env.SCRAPER_MAX_DOCS, 10) || Infinity,
  startIdx: parseInt(process.env.SCRAPER_START_IDX, 10) || 0,
};

const archiveDirectory = path.join(__dirname, 'archive');
const startedAt = new Date();

function saveZipFile(zipData, name) {
  return new Promise((resolve, reject) => {
    mkdirp(archiveDirectory, error => {
      if (error) {
        reject(error);
      } else {
        fs.writeFile(path.join(archiveDirectory, name + '.zip'), zipData, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve(zipData);
          }
        });
      }
    });
  });
}

function openZipFile(zipData) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(zipData), { lazyEntries: true }, (err, zipFile) => {
      if (err) {
        reject(err);
      } else {
        resolve(zipFile);
      }
    });
  });
}

function unpackZipFile(zipFile, destinationDirectory) {
  return new Promise((resolve, reject) => {
    zipFile.on('entry', entry => {
      const fullPath = path.join(destinationDirectory, entry.fileName);

      if (/\/$/.test(entry.fileName)) {
        mkdirp(fullPath, error => {
          if (error) {
            reject(error);
          } else {
            zipFile.readEntry();
          }
        });
      } else {
        zipFile.openReadStream(entry, (error, readStream) => {
          if (error) {
            reject(error);
          } else {
            mkdirp(path.dirname(fullPath), error => {
              if (error) {
                reject(error);
              } else {
                readStream.pipe(fs.createWriteStream(fullPath));
                readStream.on('end', () => {
                  zipFile.readEntry();
                });
              }
            });
          }
        });
      }
    });

    zipFile.on('end', resolve);

    zipFile.readEntry();
  });
}

function archiveFile(file) {
  return Promise.resolve()
    .then(() => {
      console.log(`Archiving file ${file.id} (${file.category.title}/${file.title})`);

      const email = `${config.mailbackMailbox}+${file.id}@mail.mailback.io`;

      return rp({
        uri: config.downloadUrl,
        method: 'POST',
        form: {
          SelectedFile: file.id,
          Email: email,
          reEmail: email,
          'X-Requested-With': 'XMLHttpRequest'
        }
      });
    })
    .then(() => {
      console.log(chalk.gray('File requested'));

      return rp(`http://mailback.io/html/${config.mailbackMailbox}/${file.id}`);
    })
    .then(html => {
      console.log(chalk.gray('Email received'));

      const $ = cheerio.load(html);
      const fileUrl = $('a').attr('href');

      if (!fileUrl) {
        throw new Error('Could not locate URL in email');
      }

      return fileUrl;
    })
    .then(fileUrl => {
      console.log(chalk.gray('Located file URL:', fileUrl));

      const parsed = url.parse(fileUrl);
      const name = decodeURIComponent(path.basename(parsed.pathname, '.zip'));

      file.url = fileUrl;
      file.name = name;

      return rp({
        uri: fileUrl,
        resolveWithFullResponse: true,
        encoding: null
      });
    })
    .then(response => {
      console.log(chalk.gray('File received'));

      const zipData = response.body;
      const shasum = crypto.createHash('sha1');

      shasum.update(zipData);

      // @todo check lastModifiedAt && sha1sum and skip if file already is in saved manifest
      // this would make the tool reentrant

      file.lastModifiedAt = new Date(response.headers['last-modified']);
      file.receivedAt = new Date();
      file.sha1sum = shasum.digest('hex');

      console.log(chalk.gray('Last modified:', file.lastModifiedAt.toLocaleString()));
      console.log(chalk.gray('SHA-1 sum:', file.sha1sum));

      return saveZipFile(zipData, file.name);
    })
    .then(zipData => {
      console.log(chalk.gray('File saved'));

      //return openZipFile(zipData);
    })
    // @todo disabled unpacking for now -- yauzl is bailing on file ID 11
    // .then(zipFile => {
    //   console.log(chalk.gray('Unpacking file'));
    //
    //   return unpackZipFile(zipFile, path.join(archiveDirectory, file.name));
    // })
    // .then(() => {
    //   console.log(chalk.gray('Unpacking done'));
    // })
    .catch(error => {
      console.error(chalk.red('Error archiving file:', error));
    })
}

function writeManifest(fileList) {
  const manifest = fileList;

  return new Promise((resolve, reject) => {
    fs.writeFile(path.join(archiveDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2), (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

console.log('Archiving EPA Geo Portal data to:', archiveDirectory);
console.log(chalk.gray('Started at:', startedAt.toLocaleString()));

Promise.resolve()
  .then(() => {
    console.log('Fetching index HTML');

    return rp(config.indexUrl);
  })
  .then(html => {
    console.log('Extracting file metadata');

    const $ = cheerio.load(html);

    const categoryList = $('.categories h3')
      .map((idx, el) => {
        const $el = $(el);

        return {
          id: $el.attr('class').replace(/\D/g, ''),
          title: $el.text()
        };
      })
      .get();

    const categoryMap = {};

    categoryList.forEach(category => {
      categoryMap[category.id] = category;
    });

    return $('.SelectedFile')
      .map((idx, el) => {
        const $el = $(el);

        const categoryId = $el.closest('p').attr('class').replace(/\D/g, '');

        return {
          id: $el.val(),
          category: categoryMap[categoryId],
          title: $el.parent().text()
        };
      })
      .get();
  })
  .then(fileList => {
    console.log(chalk.gray(`Found ${fileList.length} file(s)`));

    const numFilesToArchive = Math.min(fileList.length, config.maxDocs);
    const archivableFileList = fileList.slice(config.startIdx, config.startIdx + numFilesToArchive);

    console.log(`Archiving ${archivableFileList.length} file(s)`);

    return enqueue(
      archivableFileList,
      (file) => {
        return archiveFile(file)
          .then(() => writeManifest(archivableFileList))
          .then(() => console.log(chalk.gray('Manifest written')));
      }
    );
  })
  .then(() => {
    console.log(chalk.green('All done!'));

    const finishedAt = new Date();
    const elapsed = finishedAt - startedAt;

    console.log(chalk.gray('Finished at:', finishedAt.toLocaleString()));
    console.log(chalk.gray('Elapsed:', humanizeDuration(elapsed)));
  })
  .catch(chalk.red(console.error));

  process.on('unhandledRejection', (reason, p) => {
    console.error(chalk.red('Unhandled rejection at Promise', p, 'reason:', reason));
  });
