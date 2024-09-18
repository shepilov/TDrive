import { CREDENTIALS_SECRET } from '@/config';
import { OfficeToken } from '@/interfaces/office-token.interface';
import driveService from '@/services/drive.service';
import fileService from '@/services/file.service';
import logger from '@/lib/logger';
import * as OnlyOffice from '@/services/onlyoffice.service';
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import * as Utils from '@/utils';

interface RequestQuery {
  company_id: string;
  file_id: string;
  token: string;
}

/** These expose a OnlyOffice document storage service methods, called by the OnlyOffice document editing service
 * to load and save files
 */
class OnlyOfficeController {
  /**
   * Get a file from Twake Drive backend, and proxy it back the previewer/editor (via the document editing service).
   *
   * Parameters are standard Express middleware.
   * @see https://api.onlyoffice.com/editors/open
   */
  public read = async (req: Request<{}, {}, {}, RequestQuery>, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { token } = req.query;

      const officeTokenPayload = jwt.verify(token, CREDENTIALS_SECRET) as OfficeToken;
      const { company_id, file_id, in_page_token } = officeTokenPayload;

      // check token is an in_page_token
      if (!in_page_token) throw new Error('Invalid token, must be a in_page_token');

      if (!file_id) throw new Error(`File id is missing in the last version cache for ${JSON.stringify(file_id)}`);
      const file = await fileService.download({
        company_id,
        file_id: file_id,
      });

      file.pipe(res);
    } catch (error) {
      next(error);
    }
  };

  /**
   * Receive a file from OnlyOffice document editing service and save it into Twake Drive backend.
   *
   * This is the endpoint of the callback url provided to the editor in the browser.
   *
   * Parameters are standard Express middleware.
   * @see https://api.onlyoffice.com/editors/save
   * @see https://api.onlyoffice.com/editors/callback
   */
  public ooCallback = async (
    req: Request<{}, {}, OnlyOffice.Callback.Parameters, RequestQuery>,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const respondToOO = (error = 0) => void res.send({ error });
    try {
      const { url, key } = req.body;
      const { token } = req.query;
      logger.info(
        `OO callback status: ${Utils.getKeyForValueSafe(req.body.status, OnlyOffice.Callback.Status, 'Callback.Status')} - ${JSON.stringify(
          req.body.userdata,
        )}`,
        req.body,
      );
      const officeTokenPayload = jwt.verify(token, CREDENTIALS_SECRET) as OfficeToken;
      const { preview, /* company_id, file_id, user_id, drive_file_id, */ in_page_token /* editing_session_key */ } = officeTokenPayload;

      // check token is an in_page_token and allow save
      if (!in_page_token) throw new Error('OO Callback invalid token, must be a in_page_token');
      if (preview) throw new Error('OO Callback invalid token, must not be a preview token for save operation');

      switch (req.body.status) {
        case OnlyOffice.Callback.Status.BEING_EDITED:
          // TODO this call back we recieve almost all the time, and here we save
          // the user identifiers who start file editing and even control the amount of onlin users
          // to have license constraint warning before OnlyOffice error about this
          // No-op
          break;

        case OnlyOffice.Callback.Status.BEING_EDITED_BUT_IS_SAVED:
          logger.info(`OO Callback force save for session ${key} for reason: ${OnlyOffice.Callback.ForceSaveTypeToString(req.body.forcesavetype)}`);
          await driveService.addEditingSessionVersion(key, url); //, token); //TODO Fix user token (getting 401)
          break;

        case OnlyOffice.Callback.Status.READY_FOR_SAVING:
          logger.info(`OO Callback new version for session ${key} created`);
          await driveService.endEditing(key, url); //, token); //TODO Fix user token (getting 401)
          break;

        case OnlyOffice.Callback.Status.CLOSED_WITHOUT_CHANGES:
          await driveService.cancelEditing(key);
          break;

        case OnlyOffice.Callback.Status.ERROR_SAVING:
          // TODO: Save end of transaction ?
          logger.error(`OO Callback with Status.ERROR_SAVING: ${req.body.url} (key: ${req.body.key})`);
          break;

        case OnlyOffice.Callback.Status.ERROR_FORCE_SAVING:
          // TODO: notify user ?
          logger.error(
            `OO Callback with Status.ERROR_FORCE_SAVING (reason: ${OnlyOffice.Callback.ForceSaveTypeToString(req.body.forcesavetype)}) file ${
              req.body.url
            } (key: ${req.body.key})`,
          );
          break;

        default:
          throw new Error(
            `OO Callback unexpected status field: ${OnlyOffice.Callback.StatusToString(req.body.status)} in ${JSON.stringify(req.body)}`,
          );
      }

      // Ignore errors generated by pending request
      // try-catch not needed because it is async
      // there may be later reasons to wait for callbacks
      // to process and eventually respond accordingly to
      // OO an error for certain statuses
      void OnlyOffice.default.ooCallbackCalled(req.body); // has to be single thread per key

      return respondToOO(0);
    } catch (error) {
      logger.error(`OO Callback root error`, { error });
      next(error || 'error');
    }
  };
}

export default OnlyOfficeController;
