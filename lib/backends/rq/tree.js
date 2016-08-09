/*
 *  Copyright 2015 Adobe Systems Incorporated. All rights reserved.
 *  This file is licensed to you under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License. You may obtain a copy
 *  of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software distributed under
 *  the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 *  OF ANY KIND, either express or implied. See the License for the specific language
 *  governing permissions and limitations under the License.
 */

'use strict';

var util = require('util');

var logger = require('winston').loggers.get('spi');

var RQLocalTree = require('./localtree');
var DAMTree = require('../dam/tree');
var RQFile = require('./file');
var FSFile = require('../fs/file');
var Path = require('path');
var request = require('request');
var utils = require('../../utils');
var RequestQueue = require('./requestqueue');
var RQProcessor = require('./rqprocessor');

/**
 * Creates an instance of RQTree.
 *
 * @constructor
 * @this {RQTree}
 * @param {RQShare} share parent share
 * @param {Object} content JCR node representation
 * @param {Tree} tempFilesTree temporary files tree
 */
var RQTree = function (share, content, tempFilesTree) {
  if (!(this instanceof RQTree)) {
    return new RQTree(share, content, tempFilesTree);
  }

  this.local = new RQLocalTree(share, share.config.local);
  this.work = new RQLocalTree(share, share.config.work);
  this.share = share;
  this.rq = new RequestQueue({
    path: share.config.work.path
  });
  this.createdFiles = {};
  this.processor = new RQProcessor(this, this.rq);

  this.processor.on('syncstart', function (data) {
    logger.info('start sync %s %s', data.method, data.file);
  });

  this.processor.on('syncend', function (data) {
    logger.info('end sync %s %s', data.method, data.file);
  });

  this.processor.on('syncerr', function (data) {
    logger.error('err sync %s %s', data.method, data.file, data.err);
  });

  this.processor.on('error', function (err) {
    logger.error('there was a general error in the processor', err);
  });

  this.processor.on('purged', function (purged) {
    logger.info('failed files were purged from the queue', purged);
  });

  this.processor.start(share.config);

  DAMTree.call(this, share, content, tempFilesTree);
};

// the RQTree prototype inherits from DAMTree
util.inherits(RQTree, DAMTree);

RQTree.prototype.getLocalPath = function (name) {
  return Path.join(this.share.config.local.path, name);
}

RQTree.prototype.getRemotePath = function (name) {
  return this.share.buildResourceUrl(name);
}

//---------------------------------------------------------------------< Tree >

/**
 * Test whether or not the specified file exists.
 *
 * @param {String} name file name
 * @param {Function} cb callback called with the result
 * @param {SMBError} cb.error error (non-null if an error occurred)
 * @param {Boolean} cb.exists true if the file exists; false otherwise
 */
RQTree.prototype.exists = function (name, cb) {
  logger.debug('[%s] tree.exists %s', this.share.config.backend, name);
  // first check to see if the file exists locally
  var self = this;
  this.local.exists(name, function (err, result) {
    if (err) {
      cb(err);
    }  else {
      if (result) {
        // if exists locally, return immediately
        cb(null, result);
      } else {
        // otherwise check to see if the file exists remotely
        DAMTree.prototype.exists.call(self, name, function (err, result) {
          if (err) {
            cb(err);
          } else {
            cb(null, result);
          }
        });
      }
    }
  });
};

/**
 * Open an existing file.
 *
 * @param {String} name file name
 * @param {Function} cb callback called with the opened file
 * @param {SMBError} cb.error error (non-null if an error occurred)
 * @param {File} cb.file opened file
 */
RQTree.prototype.open = function (name, cb) {
  logger.debug('[%s] tree.open %s', this.share.config.backend, name);
  var self = this;
  DAMTree.prototype.exists.call(self, name, function (err, remoteExists) {
    if (err) {
      cb(err);
    } else {
      self.local.exists(name, function (err, localExists) {
        if (err) {
          cb(err);
        } else {
          if (remoteExists && !localExists) {
            // remote file exists but local does not
            RQFile.createInstance(name, self, cb);
          } else {
            // local file exists
            self.local.open(name, function (err, localFile) {
              if (err) {
                cb(err);
              } else {
                if (!remoteExists) {
                  // local file only exists
                  RQFile.createInstanceFromLocal(name, self, localFile, cb);
                } else {
                  // both local and remote exist
                  DAMTree.prototype.open.call(self, name, function (err, remoteFile) {
                    if (err) {
                      cb(err);
                    } else {
                      RQFile.createInstanceFromLocalAndRemote(name, self, localFile, remoteFile, cb);
                    }
                  });
                }
              }
            });
          }
        }
      });
    }
  });
};

/**
 * List entries, matching a specified pattern.
 *
 * @param {String} pattern pattern
 * @param {Function} cb callback called with an array of matching files
 * @param {SMBError} cb.error error (non-null if an error occurred)
 * @param {File[]} cb.files array of matching files
 */
RQTree.prototype.list = function (pattern, cb) {
  logger.debug('[%s] tree.list %s', this.share.config.backend, pattern);
  var self = this;
  DAMTree.prototype.list.call(self, pattern, function (err, remoteFiles) {
    if (err) {
      cb(err);
    } else {
      var parentPath = utils.getParentPath(pattern) || '';
      self.local.exists(parentPath, function (err, exists) {
        if (err) {
          cb(err);
        } else {
          if (exists) {
            self.local.list(pattern, function (err, localFiles) {
              if (err) {
                cb(err);
              } else {
                self.rq.getRequests(parentPath, function (err, requests) {
                  var i;
                  var lookup = {};
                  var remoteLookup = {};
                  var rqFiles = [];
                  for (i = 0; i < remoteFiles.length; i++) {
                    if (requests[remoteFiles[i].getName()] != 'DELETE') {
                      rqFiles.push(RQFile.createInstanceFromRemote(remoteFiles[i].getPath(), self, remoteFiles[i]));
                      lookup[remoteFiles[i].getName()] = rqFiles.length - 1;
                      remoteLookup[remoteFiles[i].getName()] = i;
                    }
                  }
                  var processLocal = function (index) {
                    if (index < localFiles.length) {
                      if (self.isTempFileName(localFiles[index].getName())) {
                        // it's a temporary file, just add it to the list
                        RQFile.createInstanceFromLocal(localFiles[index].getName(), self, localFiles[index], function (err, rqFile) {
                          if (err) {
                            cb(err);
                          } else {
                            rqFiles.push(rqFile);
                            processLocal(index + 1);
                          }
                        });
                      } else {
                        var remoteIndex = lookup[localFiles[index].getName()];
                        var origRemoteIndex = remoteLookup[localFiles[index].getName()];
                        if (remoteIndex !== undefined) {
                          RQFile.createInstanceFromLocalAndRemote(localFiles[index].getPath(), self, localFiles[index], remoteFiles[origRemoteIndex], function (err, rqFile) {
                            if (err) {
                              cb(err);
                            } else {
                              rqFiles[remoteIndex] = rqFile;
                              processLocal(index + 1);
                            }
                          });
                        } else {
                          RQFile.createInstanceFromLocal(localFiles[index].getPath(), self, localFiles[index], function (err, rqFile) {
                            if (err) {
                              cb(err);
                            } else {
                              self.work.exists(self.getCreateFileName(localFiles[index].getPath()), function (err, exists) {
                                if (err) {
                                  cb(err);
                                } else {
                                  if (exists) {
                                    rqFiles.push(rqFile);
                                    processLocal(index + 1);
                                  } else {
                                    // the file was not in the remote list of files, and it doesn't have a local creation
                                    // file indicating that it was created locally. Determine if it's safe to delete and
                                    // do so
                                    rqFile.canDelete(function (err, canDelete) {
                                      if (err) {
                                        cb(err);
                                      } else if (canDelete) {
                                        // file can be safely deleted. remove it.
                                        localFiles[index].delete(function (err) {
                                          if (err) {
                                            cb(err);
                                          } else {
                                            RQFile.deleteWorkFiles(localFiles[index].getPath(), self, function (err) {
                                              if (err) {
                                                cb(err);
                                              } else {
                                                logger.info('file %s was deleted remotely. exclude from file list', rqFile.getPath());
                                                processLocal(index + 1);
                                              }
                                            });
                                          }
                                        });
                                      } else {
                                        // file can't be safely deleted, send conflict event
                                        logger.info('file %s is in conflict because it might need to be deleted. sending event', rqFile.getPath());
                                        rqFiles.push(rqFile);
                                        processLocal(index + 1);
                                      }
                                    });
                                  }
                                }
                              });
                            }
                          });
                        }
                      }
                    } else {
                      cb(null, rqFiles);
                    }
                  };
                  processLocal(0);
                });
              }
            });
          } else {
            cb(null, remoteFiles);
          }
        }
      });
    }
  });
};

/**
 * Queues a request in the backend request queue.
 * @param {String} name The name of the file to be queued.
 * @param {String} method The HTTP method to queue.
 * @param [String] newName The new name of the file, which is required for move or copy
 */
RQTree.prototype.queueData = function (name, method, newName) {
  var isTempFile = this.isTempFileName(name);
    var options = {
      method: method,
      path: name,
      remotePrefix: this.share.buildResourceUrl(''),
      localPrefix: this.share.config.local.path
    };
    if (newName) {
      options['destPath'] = newName;
      isTempFile = isTempFile && this.isTempFileName(newName);
    }
  if (!isTempFile) {
    this.rq.queueRequest(options, function (err) {
      if (err) {
        logger.error('unable to queue request', options, err);
      }
    });
  }
};

/**
 * Retrieves the name of the file used to indicate that a file was created locally.
 * @returns {String} The name of the create file.
 */
RQTree.prototype.getCreateFileName = function (name) {
  return name + '.rqcf';
}

/**
 * Create a new file.
 *
 * @param {String} name file name
 * @param {Function} cb callback called on completion
 * @param {SMBError} cb.error error (non-null if an error occurred)
 * @param {File} cb.file created file
 */
RQTree.prototype.createFile = function (name, cb) {
  logger.debug('[%s] tree.createFile %s', this.share.config.backend, name);
  var self = this;
  self.local.createFile(name, function (err, file) {
    if (err) {
      cb(err);
    } else {
      self.work.createFile(self.getCreateFileName(name), function (err, createdFile) {
        if (err) {
          cb(err);
        } else {
          self.createdFiles[name] = true;
          self.share.invalidateContentCache(utils.getParentPath(name), true);
          RQFile.createInstanceFromLocal(name, self, file, cb);
        }
      });
    }
  });
};

/**
 * Create a new directory.
 *
 * @param {String} name directory name
 * @param {Function} cb callback called on completion
 * @param {SMBError} cb.error error (non-null if an error occurred)
 * @param {File} cb.file created directory
 */
RQTree.prototype.createDirectory = function (name, cb) {
  logger.debug('[%s] tree.createDirectory %s', this.share.config.backend, name);
  var self = this;
  self.local.createDirectory(name, function (err, file) {
    if (err) {
      cb(err);
    } else {
      // create directory immediately
      DAMTree.prototype.createDirectory.call(self, name, cb);
    }
  });
};

/**
 * Delete a file.
 *
 * @param {String} name file name
 * @param {Function} cb callback called on completion
 * @param {SMBError} cb.error error (non-null if an error occurred)
 */
 RQTree.prototype.delete = function (name, cb) {
   logger.info('[%s] tree.delete %s', this.share.config.backend, name);
   var self = this;
   self.local.exists(name, function (err, exists) {
     if (err) {
       cb(err);
     } else {
       if (exists) {
         self.local.delete(name, function (err) {
           if (err) {
             cb(err);
           } else {
             self.share.invalidateContentCache(utils.getParentPath(name), true);
             self.queueData(name, 'DELETE');
             RQFile.deleteWorkFiles(name, self, function (err) {
               if (err) {
                 logger.error('unexpected error while trying to clean up rq file after deletion', err);
               }
               cb(null);
             });
           }
         });
       } else {
         DAMTree.prototype.delete.call(self, name, cb);
       }
     }
   });
 };

/**
 * Delete a directory. It must be empty in order to be deleted.
 *
 * @param {String} name directory name
 * @param {Function} cb callback called on completion
 * @param {SMBError} cb.error error (non-null if an error occurred)
 */
RQTree.prototype.deleteDirectory = function (name, cb) {
  logger.debug('[%s] tree.deleteDirectory %s', this.share.config.backend, name);
  var self = this;
  self.local.exists(name, function (err, exists) {
    if (err) {
      cb(err);
    } else {
      if (exists) {
        self.local.deleteDirectory(name, function (err) {
          if (err) {
            cb(err);
          } else {
            DAMTree.prototype.deleteDirectory.call(self, name, function (err) {
              if (err) {
                cb(err);
              } else {
                self.rq.removePath(name, function (err) {
                  if (err) {
                    cb(err);
                  } else {
                    self.work.exists(name, function (err, exists) {
                      if (err) {
                        cb(err);
                      } else {
                        if (exists) {
                          self.work.deleteDirectory(name, cb);
                        } else {
                          cb();
                        }
                      }
                    });
                  }
                });
              }
            });
          }
        });
      } else {
        DAMTree.prototype.deleteDirectory.call(self, name, cb);
      }
    }
  });
};

/**
 * Rename a file or directory.
 *
 * @param {String} oldName old name
 * @param {String} newName new name
 * @param {Function} cb callback called on completion
 * @param {SMBError} cb.error error (non-null if an error occurred)
 */
RQTree.prototype.rename = function (oldName, newName, cb) {
  logger.debug('[%s] tree.rename %s to %s', this.share.config.backend, oldName, newName);
  var self = this;
  self.local.exists(oldName, function (err, exists) {
    if (err) {
      cb(err);
    } else {
      // only attempt to rename the item in the local cache if it already exists
      if (exists) {
        self.local.rename(oldName, newName, function (err) {
          if (err) {
            cb(err);
          } else {
            // invalidate cache
            self.share.invalidateContentCache(utils.getParentPath(oldName), true);
            self.share.invalidateContentCache(utils.getParentPath(newName), true);
            FSFile.createInstance(newName, self.local, function (err, file) {
              if (err) {
                cb(err);
              } else {
                self.work.exists(oldName, function (err, exists) {
                  if (err) {
                    cb(err);
                  } else {
                    self.work.exists(self.getCreateFileName(oldName), function (err, createdExists) {
                      if (err) {
                        cb(err);
                      } else {
                        var queueRename = function () {
                          if (file.isDirectory()) {
                            DAMTree.prototype.rename.call(self, oldName, newName, function (err) {
                              if (err) {
                                cb(err);
                              } else {
                                self.rq.updatePath(oldName, newName, function (err) {
                                  if (err) {
                                    cb(err);
                                  } else {
                                    cb();
                                  }
                                });
                              }
                            });
                          } else {
                            self.queueData(oldName, 'MOVE', newName);
                            cb();
                          }
                        };

                        var renameCreated = function () {
                          if (exists) {
                            self.work.rename(oldName, newName, function (err) {
                              if (err) {
                                cb(err);
                              } else {
                                queueRename();
                              }
                            });
                          } else {
                            queueRename();
                          }
                        };

                        if (createdExists) {
                          self.work.rename(self.getCreateFileName(oldName), self.getCreateFileName(newName), function (err) {
                            if (err) {
                              cb(err);
                            } else {
                              renameCreated();
                            }
                          });
                        } else {
                          renameCreated();
                        }
                      }
                    });
                  }
                });
              }
            });
          }
        });
      } else {
        DAMTree.prototype.rename.call(self, oldName, newName, cb);
      }
    }
  });
};

module.exports = RQTree;
