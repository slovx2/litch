package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/slovx2/litch/internal/hostplatform"
)

var errPowerRegistrationUnsupported = errors.New("local power registration is not supported by the running service")

func (s *controlServer) handlePower(method string, params json.RawMessage) (any, *controlError) {
	if s.power == nil {
		return nil, controlFailure(errors.New(tr("电源控制器未启动", "The power controller is not running")))
	}
	switch method {
	case "power.registerLocal":
		if err := s.manager.registerLocalPower(); err != nil {
			return nil, controlFailure(err)
		}
		s.power.refresh()
	case "power.activity":
		return s.handlePowerActivity(params, nil)
	}
	return s.power.read(), nil
}

func (s *controlServer) handlePowerActivity(params json.RawMessage, owner any) (any, *controlError) {
	var request powerActivity
	if failure := decodeControlParams(params, &request); failure != nil {
		return nil, failure
	}
	return s.power.activityFrom(request, owner)
}

// 直接连本机控制套接字登记，不通过 app-server 向任意远程服务暴露归属设置。
func registerLocalPowerService(c configuration) error {
	connection, err := hostplatform.Dial(hostplatform.ControlSocketPath(c.deviceDirectory()))
	if err != nil {
		return fmt.Errorf(tr("无法登记本机服务，请检查设备控制通道: %w", "cannot register the local service; check its control channel: %w"), err)
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(8 * time.Second))
	if _, err = connection.Write([]byte("{\"id\":1,\"method\":\"power.registerLocal\",\"params\":{}}\n")); err != nil {
		return err
	}
	reader := bufio.NewReader(connection)
	for {
		line, err := readControlLine(reader)
		if err != nil {
			return err
		}
		var frame struct {
			ID     *int          `json:"id"`
			Ask    *int          `json:"ask"`
			Result powerStatus   `json:"result"`
			Error  *controlError `json:"error"`
		}
		if json.Unmarshal(line, &frame) != nil {
			continue
		}
		if frame.Ask != nil {
			answer, _ := json.Marshal(map[string]any{"reply": *frame.Ask, "error": "not the device process"})
			if _, err := connection.Write(append(answer, '\n')); err != nil {
				return err
			}
			continue
		}
		if frame.ID == nil || *frame.ID != 1 {
			continue
		}
		if frame.Error != nil {
			// 已发布的控制通道把未知方法也归为 failed，只能按这份确定的应答识别能力缺失。
			// 不能把所有 failed、连接失败或磁盘错误都当成旧服务，否则会伪装登记结果。
			unknown := both("不认识的控制命令 power.registerLocal", "Unknown control command power.registerLocal")
			if frame.Error.Reason == "failed" && frame.Error.Text == unknown {
				return fmt.Errorf("%w: %s", errPowerRegistrationUnsupported, frame.Error.Text.String())
			}
			return fmt.Errorf(tr("本机电源登记失败: %s", "Local power registration failed: %s"), frame.Error.Text.String())
		}
		if !frame.Result.ConfiguredForLocalService {
			return errors.New(tr("服务未确认本机登记，请检查设备服务日志", "The service did not confirm local registration; check its log"))
		}
		return nil
	}
}
