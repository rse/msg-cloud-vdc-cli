#!/usr/bin/env node
/*
**  vdc.js -- Simple msg Cloud vDC Command-Line Interface (CLI)
**  Copyright (c) 2017 Ralf S. Engelschall <http://engelschall.com>
**
**  This Source Code Form is subject to the terms of the Mozilla Public
**  License (MPL), version 2.0. If a copy of the MPL was not distributed
**  with this file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/

/*  load external requirements  */
const Inquirer        = require("inquirer")
const Bluebird        = require("bluebird")
const co              = require("co")
const chalk           = require("chalk")
const Caporal         = require("caporal")
const SuperAgent      = require("superagent")
const SuperAgentProxy = require("superagent-proxy")
const SSH             = require("node-ssh")
const HostId          = require("hostid")
const path            = require("path")

/*  provide an outer asynchronous environment  */
co(async () => {
    /*  determine unique host identifier  */
    let hostid = HostId().replace(/-/g, "")

    /*  toggle power of a VM via vDC  */
    const vdcPower = async (level, vms, opts) => {
        /*  optionally ask for password interactively  */
        if (typeof opts.password !== "string") {
            let answers = await Inquirer.prompt([ {
                type:    "password",
                name:    "password",
                message: `${opts.username} vDC password:`
            }])
            opts.password = answers.password
        }

        /*  create a new cookie-aware HTTP agent  */
        SuperAgentProxy(SuperAgent)
        const agent = SuperAgent.agent()

        /*  optionaly support HTTP proxy  */
        if (process.env["http_proxy"] !== undefined)
            agent.proxy(process.env["http_proxy"])

        /*  authenticate via login endpoint  */
        let res = await agent
            .post(`${opts.location}/api/login`)
            .accept("application/json")
            .send({
                email:       opts.username,
                password:    opts.password,
                hash:        hostid,
                force_login: true,
                lang:        "en"
            })

        /*  determine API userid/token via panel dialog  */
        res = await agent
            .get(`${opts.location}/Panel/`)
        let [ , apiUser  ] = res.text.match(/"user":\s*'(.+?)'/)
        let [ , apiToken ] = res.text.match(/"token":\s*'(.+?)'/)
        let [ , apiURL   ] = res.text.match(/"api":\s*'(.+?)'/)

        /*  determine name/UUID of all servers  */
        res = await agent
            .get(`${apiURL}/objects/servers`)
            .accept("application/json")
            .set("X-Auth-UserId", apiUser)
            .set("X-Auth-Token",  apiToken)
        let name2id = {}
        let servers = res.body.servers
        Object.keys(servers).forEach((id) => {
            let server = servers[id]
            name2id[server.name] = id
        })

        /*  iterate over all VMs  */
        let vmmax = vms.split(/,/).length
        let vmcur = 0
        await Bluebird.each(vms.split(/,/), async (vm) => {
            /*  map name to vDC id  */
            let id = name2id[vm]
            if (typeof id !== "string")
                throw new Error(`invalid VM name "${vm}"`)

            /*  power on/off a particular VM  */
            console.log(`${chalk.blue(vm)}: switching power ${level ? "on" : "off"}`)
            res = await agent
                .patch(`${apiURL}/objects/servers/${id}/power`)
                .accept("application/json")
                .set("X-Auth-UserId", apiUser)
                .set("X-Auth-Token",  apiToken)
                .send({ power: level })

            /*  shameless workaround: vDC API dislikes subsequent power togglings within too short time  */
            if (++vmcur < vmmax)
                await new Promise((resolve, reject) => { setTimeout(resolve, 10*1000) })
        })
    }

    /*  execute a command under an OS via SSH  */
    const sshCommand = async (cmd, hosts, opts) => {
        /*  optionally ask for password interactively  */
        if (typeof opts.password !== "string") {
            let answers = await Inquirer.prompt([ {
                type:    "password",
                name:    "password",
                message: `${opts.username} SSH password:`
            }])
            opts.password = answers.password
        }

        /*  iterate over all hosts  */
        await Bluebird.each(hosts.split(/,/), async (host) => {
            /*  send command to remote host via SSH  */
            let prefix = `${opts.username}@${host}: `
            console.log(`${chalk.blue(prefix)}$ ${cmd}`)
            const ssh = new SSH()
            await ssh.connect({
                host:         host,
                username:     opts.username,
                password:     opts.password,
                readyTimeout: 5*1000,
            })
            let result = await ssh.execCommand(cmd, { pty: true })
            if (result.stdout !== "")
                console.log(result.stdout.replace(/^/mg, chalk.blue(prefix)))
        })
    }

    /*  parse command-line arguments  */
    const pkg = require(path.join(__dirname, "package.json"))
    let command = null
    const action = (name) =>
        (args, opts, logger) =>
            command = { name: name, args, opts }
    Caporal
        .version(pkg.version)
        .description("Simple msg Cloud Virtual Data Center (vDC) Command-Line Interface (CLI)")

        /*  power-on command  */
        .command("power-on", "Switch power of a VM ON via vDC").alias("on")
        .option("-l, --location <url>", "The vDC URL", /^http/, "https://vdc.msg.systems")
        .option("-u, --username <username>", "The vDC login username (usually the Email address)")
        .option("-p, --password <password>", "The vDC login password")
        .argument("<vm-name>", "Name of VM(s)")
        .action(action("power-on"))

        /*  power-off command  */
        .command("power-off", "Switch power of a VM OFF via vDC").alias("off")
        .option("-l, --location <url>", "The vDC URL", /^http/, "https://vdc.msg.systems")
        .option("-u, --username <username>", "The vDC login username (usually the Email address)")
        .option("-p, --password <password>", "The vDC login password")
        .argument("<vm-name>", "Name of VM(s)")
        .action(action("power-off"))

        /*  exec command  */
        .command("exec", "Execute a shell command under an OS via SSH")
        .option("-u, --username <username>", "The OS login username", /^.+$/, "root")
        .option("-p, --password <password>", "The OS login password")
        .argument("<host-name>", "Name of host(s)")
        .argument("<command>", "Command to execute")
        .action(action("exec"))
    Caporal.parse(process.argv)

    /*  dispatch according to command  */
    if (command == null)
        process.exit(1)
    switch (command.name) {
        case "power-on":  await vdcPower(true,  command.args.vmName, command.opts); break
        case "power-off": await vdcPower(false, command.args.vmName, command.opts); break
        case "exec":      await sshCommand(command.args.command, command.args.hostName, command.opts); break
    }

    /*  die gracefully  */
    process.exit(0)
}).catch((err) => {
    /*  central error handling  */
    console.log(`vdc: ${chalk.red("ERROR")}: ${err}`)
    console.log(`vdc: ${chalk.red("ERROR")}: ${require("util").inspect(err, { color: true, depth: 4 })}`)
    process.exit(1)
})

