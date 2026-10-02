# Download That Stuff

A web application for downloading video and audio content.

---

## Screenshots

<img width="1888" height="938" alt="57jpmjw" src="https://github.com/user-attachments/assets/2c01c228-ee48-4ab2-a540-7250cf50ce72" />


---


1. **Download the source code**
   * Click the **Code** button at the top right of this repository.
   * Select **Download ZIP**.
   * Extract (unzip) the downloaded folder on your computer.

2. **Open in VS Code**
   * Launch VS Code.
   * Go to **File** -> **Open Folder...** and select the extracted project folder.

3. **Install Dependencies**
   Open the built-in terminal (**Terminal** -> **New Terminal**) and run:

   ```bash
   npm install
   ```

4. **Enable One-Click Reconnect (Linux)**
   On Linux in a logged-in systemd user session, `npm install` installs and enables the user service automatically. Headless or non-Linux installs skip this step. If you installed dependencies before this feature was added, run:

   ```bash
   npm run setup-supervisor
   ```

   The supervisor runs on `127.0.0.1:8001` and starts the downloader when you press **Retry connection**. It is installed for your user and starts automatically with your session.

5. **Start the Application Once**
   Start the downloader and open the page while online so the browser can cache the app shell:

   ```bash
   npm start
   ```

6. **Open in Browser**
   Open this address in your browser:

   ```text
   http://localhost:8000/
   ```

After the first online visit, **Retry connection** can start the downloader if it is stopped. Without the supervisor, the button can only check whether the downloader is running.

To update manually, get the latest source from the project repository.

